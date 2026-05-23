param(
  [string] $Profile = 'default',
  [string] $Region = 'us-west-2',
  [string] $CertificateRegion = 'us-east-1',
  [string] $Domain = 'victor-yeung.com',
  [string] $HostedZoneId = 'Z0659489BL36QJD9CF0F'
)

$ErrorActionPreference = 'Stop'

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraRoot = Split-Path -Parent $ScriptRoot
$RepoRoot = Split-Path -Parent $InfraRoot
$WwwDomain = "www.$Domain"
$CloudFrontHostedZoneId = 'Z2FDTNDATAQYW2'

function Resolve-AwsCli {
  if ($env:AWS_CLI_PATH -and (Test-Path -LiteralPath $env:AWS_CLI_PATH)) {
    return $env:AWS_CLI_PATH
  }

  $command = Get-Command aws -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $defaultPath = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
  if (Test-Path -LiteralPath $defaultPath) {
    return $defaultPath
  }

  throw 'AWS CLI was not found. Install AWS CLI v2 or set AWS_CLI_PATH.'
}

function Resolve-Npm {
  if ($env:NPM_PATH -and (Test-Path -LiteralPath $env:NPM_PATH)) {
    return $env:NPM_PATH
  }

  $command = Get-Command npm -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $localNpm = Join-Path $RepoRoot 'tools\node\node-v24.14.0-win-x64\npm.cmd'
  if (Test-Path -LiteralPath $localNpm) {
    return $localNpm
  }

  throw 'npm was not found. Install Node.js 22+ or set NPM_PATH.'
}

$Aws = Resolve-AwsCli
$Npm = Resolve-Npm
$env:Path = "$(Split-Path -Parent $Npm);$env:Path"
$env:ASTRO_TELEMETRY_DISABLED = '1'

function Invoke-Aws {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  & $Aws @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI failed: $($Arguments -join ' ')"
  }
}

function Invoke-Npm {
  param(
    [string] $WorkingDirectory,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  Push-Location $WorkingDirectory
  try {
    & $Npm @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm failed in ${WorkingDirectory}: $($Arguments -join ' ')"
    }
  }
  finally {
    Pop-Location
  }
}

function Get-FileUri {
  param([string] $Path)

  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  return "file://$fullPath"
}

function Write-AwsJson {
  param(
    [string] $Path,
    [object] $Value
  )

  $json = $Value | ConvertTo-Json -Depth 12
  $encoding = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $json, $encoding)
}

function Get-UsableCertificateArn {
  $certificatesJson = & $Aws acm list-certificates `
    --region $CertificateRegion `
    --profile $Profile `
    --certificate-statuses ISSUED PENDING_VALIDATION `
    --output json

  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to list ACM certificates.'
  }

  $certificates = ($certificatesJson | ConvertFrom-Json).CertificateSummaryList
  foreach ($summary in $certificates) {
    if ($summary.DomainName -ne $Domain) {
      continue
    }

    $detailsJson = & $Aws acm describe-certificate `
      --certificate-arn $summary.CertificateArn `
      --region $CertificateRegion `
      --profile $Profile `
      --output json

    if ($LASTEXITCODE -ne 0) {
      throw "Unable to describe ACM certificate $($summary.CertificateArn)."
    }

    $certificate = ($detailsJson | ConvertFrom-Json).Certificate
    $names = @($certificate.SubjectAlternativeNames)
    if ($names -contains $Domain -and $names -contains $WwwDomain) {
      return $certificate.CertificateArn
    }
  }

  return $null
}

function Ensure-Certificate {
  $certificateArn = Get-UsableCertificateArn

  if (-not $certificateArn) {
    Write-Host "Requesting ACM certificate in $CertificateRegion for $Domain and $WwwDomain"
    $certificateArn = & $Aws acm request-certificate `
      --domain-name $Domain `
      --subject-alternative-names $WwwDomain `
      --validation-method DNS `
      --region $CertificateRegion `
      --profile $Profile `
      --query CertificateArn `
      --output text

    if ($LASTEXITCODE -ne 0 -or -not $certificateArn) {
      throw 'Unable to request ACM certificate.'
    }
  }
  else {
    Write-Host "Using existing ACM certificate $certificateArn"
  }

  $validationRecords = @()
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    $detailsJson = & $Aws acm describe-certificate `
      --certificate-arn $certificateArn `
      --region $CertificateRegion `
      --profile $Profile `
      --output json

    if ($LASTEXITCODE -ne 0) {
      throw "Unable to describe ACM certificate $certificateArn."
    }

    $certificate = ($detailsJson | ConvertFrom-Json).Certificate
    if ($certificate.Status -eq 'ISSUED') {
      Write-Host 'ACM certificate is already issued.'
      return $certificateArn
    }

    $validationRecords = @(
      $certificate.DomainValidationOptions |
        Where-Object { $_.ResourceRecord } |
        ForEach-Object { $_.ResourceRecord }
    )

    if ($validationRecords.Count -gt 0) {
      break
    }

    Write-Host "Waiting for ACM DNS validation records to appear ($attempt/30)"
    Start-Sleep -Seconds 5
  }

  if ($validationRecords.Count -eq 0) {
    throw 'ACM did not return DNS validation records.'
  }

  $changes = @()
  foreach ($record in $validationRecords) {
    $changes += @{
      Action = 'UPSERT'
      ResourceRecordSet = @{
        Name = $record.Name
        Type = $record.Type
        TTL = 300
        ResourceRecords = @(
          @{
            Value = $record.Value
          }
        )
      }
    }
  }

  $changeBatch = @{
    Comment = "ACM validation for $Domain"
    Changes = $changes
  }

  $validationPath = Join-Path $env:TEMP 'victor-portfolio-acm-validation.json'
  Write-AwsJson $validationPath $changeBatch

  Write-Host 'Upserting ACM validation records in Route 53'
  Invoke-Aws route53 change-resource-record-sets `
    --hosted-zone-id $HostedZoneId `
    --change-batch (Get-FileUri $validationPath) `
    --profile $Profile | Out-Host

  Write-Host 'Waiting for ACM certificate validation. This can take several minutes.'
  Invoke-Aws acm wait certificate-validated `
    --certificate-arn $certificateArn `
    --region $CertificateRegion `
    --profile $Profile

  return $certificateArn
}

function Get-StackOutput {
  param(
    [object[]] $Outputs,
    [string] $Key
  )

  $match = $Outputs | Where-Object { $_.OutputKey -eq $Key } | Select-Object -First 1
  if (-not $match) {
    throw "CloudFormation output not found: $Key"
  }

  return $match.OutputValue
}

Write-Host "Deploying M1 foundation for $Domain"

$certificateArn = Ensure-Certificate
Write-Host "Certificate ARN: $certificateArn"

Write-Host 'Installing infrastructure dependencies'
Invoke-Npm $InfraRoot install

Write-Host 'Type-checking infrastructure'
Invoke-Npm $InfraRoot run build

Write-Host 'Synthesizing CDK stack'
$Cdk = Join-Path $InfraRoot 'node_modules\.bin\cdk.cmd'
if (-not (Test-Path -LiteralPath $Cdk)) {
  throw "CDK executable not found at $Cdk"
}

Push-Location $InfraRoot
try {
  & $Cdk `
    --context "certificateArn=$certificateArn" `
    synth VictorPortfolioFoundationStack `
    --quiet

  if ($LASTEXITCODE -ne 0) {
    throw 'CDK synth failed.'
  }
}
finally {
  Pop-Location
}

Write-Host 'Deploying synthesized CloudFormation template'
$templatePath = Join-Path $InfraRoot 'cdk.out\VictorPortfolioFoundationStack.template.json'
Invoke-Aws cloudformation deploy `
  --stack-name VictorPortfolioFoundationStack `
  --template-file $templatePath `
  --capabilities CAPABILITY_IAM `
  --region $Region `
  --profile $Profile

Write-Host 'Installing site dependencies'
Invoke-Npm (Join-Path $RepoRoot 'site') install

Write-Host 'Building Astro site'
Invoke-Npm (Join-Path $RepoRoot 'site') run build

$outputsJson = & $Aws cloudformation describe-stacks `
  --stack-name VictorPortfolioFoundationStack `
  --region $Region `
  --profile $Profile `
  --query 'Stacks[0].Outputs' `
  --output json

if ($LASTEXITCODE -ne 0) {
  throw 'Unable to read CloudFormation outputs.'
}

$outputs = $outputsJson | ConvertFrom-Json
$siteBucket = Get-StackOutput $outputs 'SiteBucketName'
$distributionId = Get-StackOutput $outputs 'DistributionId'
$distributionDomainName = Get-StackOutput $outputs 'DistributionDomainName'

Write-Host "Uploading site to s3://$siteBucket"
Invoke-Aws s3 sync (Join-Path $RepoRoot 'site\dist') "s3://$siteBucket" `
  --delete `
  --profile $Profile

$route53Changes = @{
  Comment = "Point $Domain and $WwwDomain to CloudFront"
  Changes = @(
    @{
      Action = 'UPSERT'
      ResourceRecordSet = @{
        Name = "$Domain."
        Type = 'A'
        AliasTarget = @{
          HostedZoneId = $CloudFrontHostedZoneId
          DNSName = "$distributionDomainName."
          EvaluateTargetHealth = $false
        }
      }
    },
    @{
      Action = 'UPSERT'
      ResourceRecordSet = @{
        Name = "$Domain."
        Type = 'AAAA'
        AliasTarget = @{
          HostedZoneId = $CloudFrontHostedZoneId
          DNSName = "$distributionDomainName."
          EvaluateTargetHealth = $false
        }
      }
    },
    @{
      Action = 'UPSERT'
      ResourceRecordSet = @{
        Name = "$WwwDomain."
        Type = 'A'
        AliasTarget = @{
          HostedZoneId = $CloudFrontHostedZoneId
          DNSName = "$distributionDomainName."
          EvaluateTargetHealth = $false
        }
      }
    },
    @{
      Action = 'UPSERT'
      ResourceRecordSet = @{
        Name = "$WwwDomain."
        Type = 'AAAA'
        AliasTarget = @{
          HostedZoneId = $CloudFrontHostedZoneId
          DNSName = "$distributionDomainName."
          EvaluateTargetHealth = $false
        }
      }
    }
  )
}

$route53Path = Join-Path $env:TEMP 'victor-portfolio-cloudfront-aliases.json'
Write-AwsJson $route53Path $route53Changes

Write-Host 'Upserting Route 53 aliases to CloudFront'
Invoke-Aws route53 change-resource-record-sets `
  --hosted-zone-id $HostedZoneId `
  --change-batch (Get-FileUri $route53Path) `
  --profile $Profile | Out-Host

Write-Host 'Invalidating CloudFront'
Invoke-Aws cloudfront create-invalidation `
  --distribution-id $distributionId `
  --paths '/*' `
  --profile $Profile | Out-Host

Write-Host 'Done.'
Write-Host "CloudFront domain: https://$distributionDomainName"
Write-Host "Website: https://$Domain"
Write-Host "WWW redirect: https://$WwwDomain"

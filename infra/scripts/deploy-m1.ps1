param(
  [string] $Profile = 'default',
  [string] $Region = 'us-west-2',
  [string] $CertificateRegion = 'us-east-1'
)

$ErrorActionPreference = 'Stop'

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraRoot = Split-Path -Parent $ScriptRoot
$RepoRoot = Split-Path -Parent $InfraRoot

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

function Import-EnvFile {
  param(
    [string] $Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }

    $index = $trimmed.IndexOf('=')
    if ($index -le 0) {
      continue
    }

    $name = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

function Assert-AdminCredentials {
  if (-not $env:ADMIN_USERNAME -or -not $env:ADMIN_PASSWORD) {
    throw 'Set ADMIN_USERNAME and ADMIN_PASSWORD in infra\.env or the current shell before deploying M4.'
  }
}

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

function Invoke-Cdk {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  $cdk = Join-Path $InfraRoot 'node_modules\.bin\cdk.cmd'
  if (-not (Test-Path -LiteralPath $cdk)) {
    throw "CDK executable not found at $cdk"
  }

  Push-Location $InfraRoot
  try {
    & $cdk @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "CDK failed: $($Arguments -join ' ')"
    }
  }
  finally {
    Pop-Location
  }
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

Import-EnvFile (Join-Path $InfraRoot '.env')
Assert-AdminCredentials

Write-Host 'Resolving AWS account'
$accountId = & $Aws sts get-caller-identity --profile $Profile --query Account --output text
if ($LASTEXITCODE -ne 0 -or -not $accountId) {
  throw 'Unable to resolve AWS account for the selected profile.'
}

Write-Host "Deploying portfolio infrastructure in account $accountId"

Write-Host 'Installing infrastructure dependencies'
Invoke-Npm $InfraRoot install

Write-Host 'Installing Sharp Lambda layer dependencies for linux x64'
$sharpLayerNodejs = Join-Path $InfraRoot 'layers\sharp\nodejs'
Invoke-Npm $sharpLayerNodejs install --omit=dev --os=linux --cpu=x64 --libc=glibc

Write-Host 'Type-checking infrastructure'
Invoke-Npm $InfraRoot run build

Write-Host 'Bootstrapping CDK environments'
Invoke-Cdk bootstrap "aws://$accountId/$CertificateRegion" "aws://$accountId/$Region" --profile $Profile

Write-Host 'Deploying CDK stacks'
Invoke-Cdk deploy --all --profile $Profile --require-approval never

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

Write-Host 'Invalidating CloudFront'
Invoke-Aws cloudfront create-invalidation `
  --distribution-id $distributionId `
  --paths '/*' `
  --profile $Profile | Out-Host

Write-Host 'Done.'
Write-Host "CloudFront domain: https://$distributionDomainName"
Write-Host 'Website: https://victor-yeung.com'
Write-Host 'WWW redirect: https://www.victor-yeung.com'

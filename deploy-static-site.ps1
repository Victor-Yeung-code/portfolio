$ErrorActionPreference = 'Stop'

$Domain = 'victor-yeung.com'
$Region = 'us-west-2'
$HostedZoneId = 'Z0659489BL36QJD9CF0F'
$Aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-FileUri($Path) {
  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  return "file://$fullPath"
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

$indexPath = Join-Path $Root 'index.html'
$websitePath = Join-Path $Root 'aws-website.json'
$policyPath = Join-Path $Root 'aws-bucket-policy.json'
$route53Path = Join-Path $Root 'aws-route53-change.json'

Write-Host "Deploying $Domain from $Root"

$bucketName = & $Aws s3api list-buckets `
  --query "Buckets[?Name=='$Domain'].Name | [0]" `
  --output text `
  --profile default

if ($LASTEXITCODE -ne 0) {
  throw 'Unable to list S3 buckets for the default profile.'
}

$bucketExists = $false
if ($bucketName -eq $Domain) {
  $bucketExists = $true
}

if (-not $bucketExists) {
  Write-Host "Creating S3 bucket $Domain in $Region"
  Invoke-Aws s3api create-bucket `
    --bucket $Domain `
    --region $Region `
    --create-bucket-configuration "LocationConstraint=$Region" `
    --profile default
}
else {
  Write-Host "S3 bucket $Domain already exists"
}

Write-Host "Allowing public website reads for $Domain"
Invoke-Aws s3api put-public-access-block `
  --bucket $Domain `
  --public-access-block-configuration "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false" `
  --profile default

Invoke-Aws s3api put-bucket-policy `
  --bucket $Domain `
  --policy (Get-FileUri $policyPath) `
  --profile default

Write-Host "Enabling S3 static website hosting"
Invoke-Aws s3api put-bucket-website `
  --bucket $Domain `
  --website-configuration (Get-FileUri $websitePath) `
  --profile default

Write-Host "Uploading index.html"
Invoke-Aws s3 cp $indexPath "s3://$Domain/index.html" `
  --content-type 'text/html; charset=utf-8' `
  --cache-control 'no-cache' `
  --profile default

Write-Host "Pointing Route 53 apex record to the S3 website endpoint"
Invoke-Aws route53 change-resource-record-sets `
  --hosted-zone-id $HostedZoneId `
  --change-batch (Get-FileUri $route53Path) `
  --profile default

Write-Host "Done."
Write-Host "S3 website endpoint: http://$Domain.s3-website-$Region.amazonaws.com"
Write-Host "Website URL: http://$Domain"

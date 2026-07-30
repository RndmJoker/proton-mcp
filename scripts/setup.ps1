<#
.SYNOPSIS
Sets up or updates proton-mcp on Windows.

.DESCRIPTION
Installs dependencies, builds the server, runs the tests and creates the
credentials file with placeholders if it does not exist. An existing
credentials file is left untouched.

On Linux and macOS use scripts/setup.sh instead.

.PARAMETER Update
Pull the latest commits before installing and building.

.EXAMPLE
.\scripts\setup.ps1

.EXAMPLE
.\scripts\setup.ps1 -Update
#>

[CmdletBinding()]
param(
    [switch]$Update
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MinNodeMajor = 24
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# Same location as on the other platforms, so the documentation stays one text.
$CredDir = Join-Path $env:USERPROFILE '.config\proton-mcp'
$CredFile = Join-Path $CredDir 'env'

function Write-Step { param([string]$Text) Write-Host "`n== $Text" }
function Write-Info { param([string]$Text) Write-Host $Text }
function Stop-WithError {
    param([string]$Text)
    Write-Host "`nFAILED: $Text" -ForegroundColor Red
    exit 1
}

Write-Step 'Checking prerequisites'

foreach ($tool in 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Stop-WithError "$tool is not installed. proton-mcp needs Node.js $MinNodeMajor or newer."
    }
}

$nodeVersion = (& node --version).Trim()
$nodeMajor = [int](($nodeVersion.TrimStart('v')).Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
    Stop-WithError "Node.js $nodeVersion is too old. Version $MinNodeMajor or newer is required."
}
Write-Info "node $nodeVersion, npm $((& npm --version).Trim())"

Set-Location $RepoRoot

if ($Update) {
    Write-Step 'Updating the working copy'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Stop-WithError 'git is not installed, so -Update cannot work.'
    }
    if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
        Stop-WithError "$RepoRoot is not a git repository, so -Update cannot work."
    }
    $dirty = & git status --porcelain
    if ($dirty) {
        Stop-WithError "There are uncommitted changes in $RepoRoot. Commit or stash them first; this script will not discard your work."
    }
    & git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError 'git pull failed. Resolve it by hand and run this script again.'
    }
    Write-Info "Now at: $(& git log -1 --format='%h %s')"
}

Write-Step 'Installing dependencies'
# npm ci is reproducible and needs the lockfile, which the repository has.
if (Test-Path (Join-Path $RepoRoot 'package-lock.json')) {
    & npm ci
} else {
    & npm install
}
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Installing dependencies failed.' }

Write-Step 'Building'
& npm run build
if ($LASTEXITCODE -ne 0) { Stop-WithError 'The build failed.' }

$serverPath = Join-Path $RepoRoot 'dist\server.js'
if (-not (Test-Path $serverPath)) {
    Stop-WithError 'The build did not produce dist\server.js.'
}

Write-Step 'Running the tests'
& npm test
if ($LASTEXITCODE -ne 0) { Stop-WithError 'The tests failed.' }

Write-Step 'Credentials'
if (Test-Path $CredFile) {
    Write-Info "$CredFile already exists and was left untouched."
} else {
    New-Item -ItemType Directory -Force -Path $CredDir | Out-Null
    @'
# Proton Mail Bridge credentials for proton-mcp.
#
# BRIDGE_PASS is the password the Bridge generates, NOT your Proton account
# password. Find it in the Bridge application under the account.
BRIDGE_USER=your.address@example.com
BRIDGE_PASS=replace-me

# The ports are configurable in the Bridge. Only set these if you changed them.
#BRIDGE_IMAP_PORT=1143
#BRIDGE_SMTP_PORT=1025
'@ | Set-Content -Path $CredFile -Encoding UTF8

    # Windows has no POSIX modes. The equivalent is removing inherited access
    # and granting the current user alone.
    try {
        $acl = Get-Acl $CredFile
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow'
        )))
        Set-Acl -Path $CredFile -AclObject $acl
        Write-Info "Created $CredFile, readable only by you."
    } catch {
        Write-Info "Created $CredFile."
        Write-Host "WARNING: could not restrict its permissions automatically. Check them by hand, the file will hold your Bridge password." -ForegroundColor Yellow
    }
    Write-Info 'Edit it and put your real address and Bridge password in.'
}

Write-Step 'Done'
$forJson = $serverPath -replace '\\', '\\'
Write-Info 'Register the server with your AI client:'
Write-Info ''
Write-Info "  claude mcp add proton -- node $serverPath"
Write-Info ''
Write-Info 'For clients that use a JSON configuration:'
Write-Info ''
Write-Info "  { `"mcpServers`": { `"proton`": { `"command`": `"node`", `"args`": [`"$forJson`"] } } }"
Write-Info ''
Write-Info 'No credentials go into the client configuration. The server reads them from'
Write-Info "$CredFile itself."
Write-Info ''
Write-Info 'Make sure Proton Mail Bridge is running and unlocked, then try asking your'
Write-Info 'assistant which mail folders you have.'

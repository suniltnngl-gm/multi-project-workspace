<#
.SYNOPSIS
    Comprehensive investigation of DEVOPS, public-code, and delta-code workspaces.

.DESCRIPTION
    Analyzes structure, key files, git status, and relationships between the three workspaces.
#>

param(
    [string]$RootPath = ".",
    [switch]$Verbose
)

# Colors for output
$colors = @{
    Header   = "Cyan"
    Success  = "Green"
    Warning  = "Yellow"
    Error    = "Red"
    Info     = "Gray"
    Key      = "Magenta"
    Path     = "DarkCyan"
}

function Write-Header { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor $colors.Header }
function Write-Success { param([string]$Text) Write-Host "  ✓ $Text" -ForegroundColor $colors.Success }
function Write-Warning { param([string]$Text) Write-Host "  ⚠ $Text" -ForegroundColor $colors.Warning }
function Write-ErrorMsg { param([string]$Text) Write-Host "  ✗ $Text" -ForegroundColor $colors.Error }
function Write-Info { param([string]$Text) Write-Host "  $Text" -ForegroundColor $colors.Info }
function Write-Key { param([string]$Key, [string]$Value) Write-Host "  ${Key}: $Value" -ForegroundColor $colors.Key }
function Write-Path { param([string]$Text) Write-Host "  $Text" -ForegroundColor $colors.Path }

# Find directories
$dirs = @(
    @{ Name = "DEVOPS"; Path = Join-Path $RootPath "DEVOPS" },
    @{ Name = "public-code"; Path = Join-Path $RootPath "public-code" },
    @{ Name = "delta-code"; Path = Join-Path $RootPath "delta-code" }
)

Write-Header "WORKSPACE INVESTIGATION REPORT"
Write-Host "Root: $RootPath"
Write-Host "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

foreach ($dir in $dirs) {
    Write-Header "WORKSPACE: $($dir.Name)"
    Write-Path "Path: $($dir.Path)"

    if (-not (Test-Path $dir.Path)) {
        Write-ErrorMsg "Directory does not exist"
        continue
    }

    # Git status
    Push-Location $dir.Path
    $gitStatus = $null
    $gitBranch = $null
    $gitRemote = $null
    $gitLastCommit = $null
    $isGitRepo = $false

    try {
        $gitStatus = git status --porcelain 2>$null
        $gitBranch = git branch --show-current 2>$null
        $gitRemote = git remote -v 2>$null | Select-Object -First 1
        $gitLastCommit = git log --oneline -1 2>$null
        $isGitRepo = $true
    } catch { }

    if ($isGitRepo) {
        Write-Success "Git repository detected"
        Write-Key "Branch" $gitBranch
        Write-Key "Last Commit" $gitLastCommit
        if ($gitRemote) { Write-Key "Remote" $gitRemote.Trim() }
        if ($gitStatus) {
            $changes = $gitStatus -split "`n" | Where-Object { $_ }
            Write-Key "Uncommitted Changes" "$($changes.Count) files"
            if ($Verbose) { $changes | ForEach-Object { Write-Info "    $_" } }
        } else {
            Write-Success "Working tree clean"
        }
    } else {
        Write-Warning "Not a git repository"
    }
    Pop-Location

    # Directory structure summary
    $items = Get-ChildItem $dir.Path -Force | Sort-Object { $_.PSIsContainer }, Name
    $dirCount = ($items | Where-Object PSIsContainer).Count
    $fileCount = ($items | Where-Object { -not $_.PSIsContainer }).Count
    Write-Key "Root Items" "$dirCount dirs, $fileCount files"

    # Key files detection
    $keyFiles = @(
        "AGENTS.md", "README.md", "package.json", "CHANGELOG.md", "LICENSE",
        "delta-code.ps1", "Install-DeltaCode.ps1", "Publish-DeltaCode.ps1",
        "update-change.ps1", "Test-ReleaseReadiness.ps1",
        "enforcement-rules.md", "enforcement-rules.schema.json",
        "detected-violations.json", "detected-violations.db",
        "tasks.md", "priority.json", "schedule.db", "close.md",
        "start.md", "tasks_checkpoints.md"
    )

    $foundKeys = @()
    foreach ($kf in $keyFiles) {
        $full = Join-Path $dir.Path $kf
        if (Test-Path $full) { $foundKeys += $kf }
    }
    if ($foundKeys.Count -gt 0) {
        Write-Success "Key files found: $($foundKeys -join ', ')"
    }

    # Modules directory
    $modPath = Join-Path $dir.Path "modules"
    if (Test-Path $modPath) {
        $mods = Get-ChildItem $modPath -Filter "*.psd1" | Select-Object -ExpandProperty BaseName
        Write-Key "Modules" "$($mods -join ', ')"
    }

    # Satellites
    $satPath = Join-Path $dir.Path "satellites"
    if (Test-Path $satPath) {
        $sats = Get-ChildItem $satPath -Directory | Select-Object -ExpandProperty Name
        Write-Key "Satellites" "$($sats -join ', ')"
    }

    # Tests
    $testPath = Join-Path $dir.Path "test"
    if (Test-Path $testPath) {
        $tests = Get-ChildItem $testPath -Filter "*.Tests.ps1" | Select-Object -ExpandProperty Name
        Write-Key "Test Suites" "$($tests -join ', ')"
    }

    # Worktrees
    if ($isGitRepo) {
        Push-Location $dir.Path
        $wt = git worktree list 2>$null
        Pop-Location
        if ($wt -and $wt.Count -gt 1) {
            Write-Key "Worktrees" "$($wt.Count) total"
            if ($Verbose) { $wt | ForEach-Object { Write-Info "    $_" } }
        }
    }

    # Size
    $size = (Get-ChildItem $dir.Path -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $sizeMB = [math]::Round($size / 1MB, 2)
    Write-Key "Disk Size" "$sizeMB MB"
}

Write-Header "CROSS-WORKSPACE ANALYSIS"

# Check for bundle-inspect in both delta-code locations
$bi1 = Join-Path $RootPath "tmp\bundle-inspect"
$bi2 = Join-Path $RootPath "delta-code\bundle-inspect"
if ((Test-Path $bi1) -and (Test-Path $bi2)) {
    Write-Warning "Duplicate bundle-inspect found:"
    Write-Path "  $bi1"
    Write-Path "  $bi2"
    # Compare
    $diff = Compare-Object (Get-ChildItem $bi1 -Recurse -Name | Sort-Object) (Get-ChildItem $bi2 -Recurse -Name | Sort-Object)
    if ($diff) {
        Write-Warning "  Differences found:"
        $diff | ForEach-Object { Write-Info "    $($_.SideIndicator) $($_.InputObject)" }
    } else {
        Write-Success "  Contents appear identical"
    }
}

# Check harness-backup in both DEVOPS and public-code
$hb1 = Join-Path $RootPath "DEVOPS\harness-backup"
$hb2 = Join-Path $RootPath "public-code\harness-backup"
if ((Test-Path $hb1) -and (Test-Path $hb2)) {
    Write-Info "harness-backup exists in both DEVOPS and public-code"
    $c1 = (Get-ChildItem $hb1 -Recurse -File).Count
    $c2 = (Get-ChildItem $hb2 -Recurse -File).Count
    Write-Key "  DEVOPS\harness-backup files" $c1
    Write-Key "  public-code\harness-backup files" $c2
}

# Check AGENTS.md in all three
foreach ($dir in $dirs) {
    $agents = Join-Path $dir.Path "AGENTS.md"
    if (Test-Path $agents) {
        $hash = (Get-FileHash $agents -Algorithm SHA256).Hash.Substring(0,16)
        Write-Key "$($dir.Name)\AGENTS.md SHA256" $hash
    }
}

Write-Header "SUMMARY"
Write-Info "DEVOPS:          Harness/backup tooling, orchestration scripts, probe outputs"
Write-Info "public-code:     Agent orchestration framework, TODO register, simulations"
Write-Info "delta-code:      Delta-Code platform (diff engine, satellites, workspaces, workflows)"
Write-Info ""
Write-Info "Note: delta-code\bundle-inspect appears to be a copy of tmp\bundle-inspect"
Write-Info "DEVOPS\harness-backup and public-code\harness-backup share similar tooling"
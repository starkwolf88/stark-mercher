$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoDir
while ($true) {
    node determine-flips.mjs
    npm run build
    Start-Sleep -Seconds 180
}

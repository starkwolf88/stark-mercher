# Disable QuickEdit mode so clicking the console window doesn't pause output
$console = [Console]::Title
$signature = '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int mode); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int mode); [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int nStdHandle);'
$types = Add-Type -MemberDefinition $signature -Name "ConsoleMode" -Namespace "Win32" -PassThru
$handle = $types::GetStdHandle(-11) # STD_OUTPUT_HANDLE
$mode = 0
[void]$types::GetConsoleMode($handle, [ref]$mode)
$mode = $mode -band (-bnot 0x0040) # Remove ENABLE_QUICK_EDIT_MODE (0x0040)
$mode = $mode -bor 0x0080          # Add ENABLE_EXTENDED_FLAGS (0x0080) so the disable takes effect
[void]$types::SetConsoleMode($handle, $mode)

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoDir
while ($true) {
    node determine-flips.mjs
    npm run build
    Start-Sleep -Seconds 180
}

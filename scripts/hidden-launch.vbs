' scripts/hidden-launch.vbs — run a command with NO console window.
'
' Windows Scheduled Tasks launch their Exec action with an interactive token, so a
' console app (bun.exe) pops a console window each time the task starts. There is no
' clean no-admin way to suppress that from the task XML itself (S4U needs elevation;
' conhost --headless detaches and breaks the task's "Running" lifecycle). wscript is
' the one in-box host with NO console of its own, so it launches the real process
' hidden — the standard no-admin "windowless task" trick.
'
' We WAIT for the child (the third Run arg = True) so wscript stays alive for the
' worker's whole lifetime. That keeps the Scheduled Task in the "Running" state,
' which the recovery logic relies on (the worker task's own watchdog trigger is
' IgnoreNew = no-op while running, relaunch when Ready; the self-heal reclaim kills
' the bun child by port, after which wscript's Run returns and the task goes Ready).
' WScript.Quit propagates the child's exit code so a crash still surfaces as the
' task's LastTaskResult.
'
' Usage (from the task action):  wscript //nologo //B hidden-launch.vbs <exe> [args...]

Option Explicit
Dim sh, args, i, a, cmd
Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments
cmd = ""
For i = 0 To args.Count - 1
  a = args(i)
  If InStr(a, " ") > 0 Then a = """" & a & """"   ' quote tokens with spaces
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & a
Next
' 0 = hidden window; True = wait for the process to exit (keeps the task Running).
WScript.Quit sh.Run(cmd, 0, True)

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Ensure no duplicate instance is running before launching
Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
Set colItems = objWMIService.ExecQuery("Select * from Win32_Process Where CommandLine Like '%zkteco-gateway.js%'")
For Each objItem in colItems
  objItem.Terminate()
Next

WScript.Sleep 1000

cmd = "node """ & scriptDir & "\zkteco-gateway.js"" --server-url https://attendance-payroll-ten.vercel.app --proxy-port 8080"
WshShell.CurrentDirectory = scriptDir
WshShell.Run cmd, 0, False

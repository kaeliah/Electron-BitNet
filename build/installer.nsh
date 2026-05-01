!macro customInit
  DetailPrint "Stopping any running ElectronBitnet process before install..."
  nsExec::ExecToLog 'taskkill /IM ElectronBitnet.exe /F'
  Sleep 1500
!macroend

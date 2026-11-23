@echo off
rem dsh-bridge-native.cmd — native messaging 启动器
rem
rem Chrome 要求 native host 的 "path" 指向一个**可执行文件**，
rem 不能直接指向 .mjs。这个 cmd 负责带上 node 运行脚本。
rem
rem 注意：native messaging 的 stdio 是二进制协议通道，
rem 这里绝不能有任何 echo / 输出，否则会破坏协议。

node "%~dp0native-host.mjs"

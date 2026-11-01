# XWorld iOS 离线打包工程

uni-app App 端 iOS 离线打包的 Xcode 工程（基于 DCloud HBuilder-Hello 改造）。

## 目录结构

| 路径 | 说明 | 是否入库 |
|---|---|---|
| `XWorldAIDrama/` | Xcode 工程本体（workspace + 两个 target + Podfile + 脚本） | ✅ |
| `uniapp.podspec` | DCloud 提供的本地 podspec，`Podfile` 以 `pod 'uniapp', :path => '..'` 引用 | ✅ |
| `SDK/` | DCloud iOS 离线打包 SDK（约 1.9G，含 Libs/Bundles/inc） | ❌ SVN 忽略，按下面步骤恢复 |
| `HBuilder-uniPluginDemo/` | DCloud 官方原生插件 demo 工程 | ❌ 忽略 |
| `XWorldAIDrama/Pods/` | CocoaPods 依赖（`pod install` 生成） | ❌ 忽略 |
| `XWorldAIDrama/XWorld-AIDrama/Pandora/` | HBuilderX 生成的本地打包 App 资源 | ❌ 忽略（与 unpackage/dist 同理） |

## 恢复构建步骤（新机器 / 新 checkout）

1. **下载 DCloud iOS 离线打包 SDK**：<https://nativesupport.dcloud.net.cn/AppDocs/download/ios>（版本以 `XWorldAIDrama/Podfile.lock` 及线上发布记录为准），解压后将 SDK 目录放到本目录下，命名必须为 `SDK/`——`uniapp.podspec` 与 `scripts/uniapp_uts_plugins.rb` 均按 `../SDK` 相对路径引用。
2. **安装 Pods**：`cd XWorldAIDrama && pod install`（source 已配置清华镜像）。
3. **生成本地打包 App 资源**：HBuilderX 打开 uniapp 工程 → 发行 → 原生 App-本地打包 → 生成本地打包 App 资源，将产物拷贝到 `XWorldAIDrama/XWorld-AIDrama/Pandora/apps/__UNI__000B765/`（该目录不入库，每次发版需重新生成）。
4. 打开 `XWorldAIDrama/XWorld-AIDrama.xcworkspace` 构建。

## 注意

- 权限描述（UsageDescription 等 Info.plist 配置）在 `XWorldAIDrama/XWorld-AIDrama/XWorld-AIDrama-Info.plist`，不在 uniapp 工程内。
- `xcuserdata`、`.DS_Store` 已按目录设置 `svn:ignore`，新加的生成物请优先补进对应目录的 ignore 而不是直接入库。

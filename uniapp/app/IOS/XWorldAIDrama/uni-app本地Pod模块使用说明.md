# HBuilder-Hello Pod 模块使用说明


## 1. 需要关注哪些文件

| 文件 | 作用 |
| --- | --- |
| `Podfile` | 选择要启用的 uni-app 模块。 |
| `uniapp_config.rb` | appid/appkey/scheme 配置文件，填写微信、地图、广告等参数。 |

一般只需要修改：

1. `Podfile`
2. `uniapp_config.rb`

## 2. 启用模块

在 `Podfile` 中找到 `uniapp_subspecs`，取消需要模块的注释即可。

示例：启用扫码、相机相册、微信支付、高德地图、优量汇广告。

```ruby
uniapp_subspecs = [
  'Core',
  'Barcode',
  'CameraGallery',
  'Payment-Wechat',
  'Map-Gaode',
  'UniAd-GDT',
]
```

修改后执行：

```sh
pod install --no-repo-update
```

如果本机系统 Ruby 执行 `pod` 有问题，可以使用当前工程验证过的 Ruby：

```sh
/Users/wangzhitong/.rvm/rubies/ruby-3.2.2/bin/ruby /Users/wangzhitong/.rvm/gems/ruby-3.2.2/bin/pod install --no-repo-update
```

## 3. 配置 appid / appkey / scheme

如果启用的模块需要业务参数，直接编辑 `uniapp_config.rb`。当前只保留这一个配置文件，不需要再复制模板文件。

示例：

```ruby
UNIAPP_PLIST_VALUES = {
  payment_wechat: {
    appid: 'wx123456',
    universal_links: 'https://example.com/app/'
  },
  payment_alipay: {
    scheme: 'your-alipay-scheme'
  },
  statistic_umeng: {
    appkey: 'umeng-appkey',
    channel: 'App Store'
  },
  map_gaode: {
    appkey: 'amap-key'
  },
  uniad: {
    market_channel: 'io.dcloud.HBuilder|appid|adid|apple',
    gdt: {
      appid: 'gdt-appid',
      splash_slotid: 'gdt-splash-id'
    }
  }
}.freeze
```

`uniapp_config.rb` 是业务配置文件，适合填写当前 App 的参数。没有启用的模块可以保持空值；如果不同环境需要不同配置，可以自行按环境维护多个版本。

## 4. 自动处理的配置

执行 `pod install` 后，工程会自动处理部分配置：

- 自动补充部分模块需要的 `Info.plist` 权限 key。
- 自动更新部分模块需要的 `PandoraApi.bundle/feature.plist` 配置。
- 自动把 `uniapp_config.rb` 中填写的 appid/appkey/scheme 写入 `Info.plist`。

权限文案只在缺失时补充；如果开发者已经在 `Info.plist` 中写了权限说明，不会被覆盖。

## 5. 基础模块

| Pod 模块 | 能力说明 |
| --- | --- |
| `Core` | 基础运行模块，必须保留。 |
| `Accelerometer` | 加速度计。 |
| `Audio` | 音频能力。 |
| `CameraGallery` | 相机、相册选择、图片/视频选择。 |
| `Contacts` | 通讯录。 |
| `File` | 文件系统。 |
| `Messaging` | 系统短信/邮件等消息能力。 |
| `Orientation` | 屏幕方向。 |
| `Proximity` | 距离传感器。 |
| `XMLHttpRequest` | 网络请求。 |
| `Zip` | 压缩/解压。 |
| `Barcode` | 扫码。 |
| `Canvas` | Canvas。 |
| `Video` | 视频播放。 |
| `Fingerprint` | 指纹识别。 |
| `FaceId` | Face ID。 |
| `BlueTooth` | 蓝牙。 |
| `Sqlite` | SQLite 数据库。 |
| `IBeacon` | iBeacon。 |
| `Log` | 日志。 |
| `LivePusher` | 直播推流。 |
| `UIWebview` | UIWebView 兼容模块。 |
| `FacialRecognitionVerify` | 实人认证/人脸认证。 |
| `UTS` | UTS 运行支持。 |
| `UTS-getLocation-tencent-uni1` | UTS 腾讯定位插件。 |
| `UTS-chooseMedia` | UTS chooseMedia 媒体选择插件。 |

## 6. 定位和地图

| Pod 模块 | 能力说明 | 需要填写 |
| --- | --- | --- |
| `Geolocation` | 系统定位。 | 无 |
| `Geolocation-Baidu` | 百度定位。 | `map_baidu.appkey` |
| `Geolocation-Gaode` | 高德定位。 | `map_gaode.appkey` |
| `Geolocation-Tencent` | 腾讯定位。 | `map_tencent.api_key` |
| `Map-Baidu` | 百度地图。 | `map_baidu.appkey` |
| `Map-Gaode` | 高德地图。 | `map_gaode.appkey` |
| `Map-Google` | Google 地图。 | 暂未自动配置 Google Maps key |

配置示例：

```ruby
UNIAPP_PLIST_VALUES = {
  map_baidu: {
    appkey: '百度地图 AppKey'
  },
  map_gaode: {
    appkey: '高德地图 AppKey'
  },
  map_tencent: {
    api_key: '腾讯位置服务 API Key'
  }
}.freeze
```

## 7. 登录模块

| Pod 模块 | 能力说明 |
| --- | --- |
| `Oauth` | 登录基础模块。 |
| `Oauth-Univerify` | 一键登录。 |
| `Oauth-Sina` | 新浪微博登录。 |
| `Oauth-QQ` | QQ 登录。 |
| `Oauth-Wechat` | 微信登录。 |
| `Oauth-Wechat-PaySDK` | 使用微信 PaySDK 版本的微信登录。 |
| `Oauth-Apple` | Apple 登录。 |
| `Oauth-Google` | Google 登录。 |
| `Oauth-Facebook` | Facebook 登录。 |

说明：登录模块的 appid、URL Scheme 当前没有自动写入，请按业务需要手动配置，或后续再扩展 `uniapp_config.rb`。

## 8. 支付模块

| Pod 模块 | 能力说明 | 需要填写 |
| --- | --- | --- |
| `Payment` | 支付基础模块。 | 无 |
| `Payment-AliPay` | 支付宝支付。 | `payment_alipay.scheme` |
| `Payment-Wechat` | 微信支付。 | `payment_wechat.appid`、`payment_wechat.universal_links` |
| `Payment-IAP` | Apple IAP。 | 无 |
| `Payment-Paypal` | PayPal 支付。 | `payment_paypal.return_url` |
| `Payment-Stripe` | Stripe 支付。 | `payment_stripe.return_url` |

配置示例：

```ruby
UNIAPP_PLIST_VALUES = {
  payment_wechat: {
    appid: '微信 AppID',
    universal_links: 'https://example.com/app/'
  },
  payment_alipay: {
    scheme: '支付宝回调 Scheme'
  },
  payment_paypal: {
    return_url: 'PayPal returnUrl'
  },
  payment_stripe: {
    return_url: 'Stripe returnUrl'
  }
}.freeze
```

## 9. 推送模块

| Pod 模块 | 能力说明 |
| --- | --- |
| `Push` | 推送基础模块。 |
| `Push-UniPush` | UniPush / 个推。 |
| `Push-Getui` | 个推。 |
| `Push-FCM` | Firebase Cloud Messaging。 |

说明：`Push-FCM` 通常还需要添加 Firebase 生成的 `GoogleService-Info.plist`。

## 10. 分享模块

| Pod 模块 | 能力说明 |
| --- | --- |
| `Share` | 分享基础模块。 |
| `Share-Sina` | 新浪微博分享。 |
| `Share-QQ` | QQ 分享。 |
| `Share-Wechat` | 微信分享。 |
| `Share-Wechat-PaySDK` | 使用微信 PaySDK 版本的微信分享。 |

说明：分享模块的 appid、URL Scheme 当前没有自动写入，请按业务需要手动配置，或后续再扩展 `uniapp_config.rb`。

## 11. 语音模块

| Pod 模块 | 能力说明 |
| --- | --- |
| `Speech` | 语音基础模块。 |
| `Speech-Baidu` | 百度语音。 |
| `Speech-Ifly` | 讯飞语音。 |

## 12. 统计模块

| Pod 模块 | 能力说明 | 需要填写 |
| --- | --- | --- |
| `Statistic` | 统计基础模块。 | 无 |
| `Statistic-Umeng` | 友盟统计。 | `statistic_umeng.appkey`、`statistic_umeng.channel` |
| `Statistic-Firebase` | Firebase 统计。 | 通常需要 `GoogleService-Info.plist` |

配置示例：

```ruby
UNIAPP_PLIST_VALUES = {
  statistic_umeng: {
    appkey: '友盟 AppKey',
    channel: 'App Store'
  }
}.freeze
```

## 13. 广告模块

`UniAd-Base` 是广告公共依赖，不需要手动添加；启用任意广告模块时会自动带上。

| Pod 模块 | 能力说明 | 可填写配置 |
| --- | --- | --- |
| `UniAd-CSJ` | 穿山甲广告。 | `uniad.csj` |
| `UniAd-Gromore` | Gromore 广告。 | `uniad.gm` |
| `UniAd-GDT` | 腾讯优量汇广告。 | `uniad.gdt` |
| `UniAd-KS` | 快手广告。 | `uniad.ks` |
| `UniAd-Sigmob` | Sigmob 广告。 | `uniad.sgm` |
| `UniAd-Baidu` | 百度广告。 | `uniad.bd` |
| `UniAd-WM` | 微信广告相关模块。 | 暂无自动参数 |
| `UniAd-WA` | 旺脉广告。 | 暂无自动参数 |
| `UniAd-AppLovin` | AppLovin 海外广告。 | 暂无自动参数 |
| `UniAd-GG` | Google AdMob。 | `uniad.gg` |
| `UniAd-GG-Pangle` | AdMob Pangle Adapter。 | 暂无自动参数 |
| `UniAd-GM-Content` | 穿山甲 Gromore 短剧。 | `uniad.gm` |
| `UniAd-InMobi` | InMobi 海外广告。 | 暂无自动参数 |
| `UniAd-IronSource` | IronSource 海外广告。 | 暂无自动参数 |
| `UniAd-KS-Content` | 快手内容联盟。 | `uniad.ks` |
| `UniAd-Liftoff` | Liftoff / Vungle 海外广告。 | 暂无自动参数 |
| `UniAd-Meta` | Meta Audience Network。 | 暂无自动参数 |
| `UniAd-Mintegral` | Mintegral 海外广告。 | 暂无自动参数 |
| `UniAd-Pangle` | Pangle / 穿山甲海外广告。 | `uniad.pg` |
| `UniAd-Unity` | UnityAds。 | 暂无自动参数 |
| `UniAd-Oct` | Oct 广告。 | 暂无自动参数 |
| `UniAd-FL` | 泛连广告。 | 暂无自动参数 |
| `UniAd-YT` | 华夏乐游广告。 | 暂无自动参数 |

广告配置示例：

```ruby
UNIAPP_PLIST_VALUES = {
  uniad: {
    # DCloud 文档格式：包名|appid|adid|渠道
    market_channel: 'io.dcloud.HBuilder|appid|adid|apple',
    gdt: {
      appid: '优量汇 AppID',
      splash_slotid: '优量汇开屏广告位'
    },
    csj: {
      appid: '穿山甲 AppID',
      splash_slotid: '穿山甲开屏广告位'
    },
    gg: {
      appid: 'AdMob AppID',
      splash_slotid: 'AdMob 开屏广告位'
    },
    pg: {
      appid: 'Pangle AppID',
      splash_slotid: 'Pangle 开屏广告位'
    }
  }
}.freeze
```

### uni-AD 额外说明

示例工程 `Podfile` 已配置广告 SDK 需要的 CocoaPods source。启用 uni-AD 相关模块后，广告三方 SDK 会通过 CocoaPods 依赖集成，不需要再从 `SDK/Libs` 手动添加对应广告三方 SDK 库。


## 15. UTS 插件自动集成

如果 HBuilderX 导出的资源中包含 `uni_modules/<插件名称>/app-ios`，可以使用示例工程提供的 UTS 插件自动集成目录。

1. 将插件目录复制到：

```text
HBuilder-Hello/UTSPlugins/<插件名称>/app-ios
```

2. `DCloudUTSFoundation.framework` 已内置为 `uniapp/Core` 的必选依赖。`pod install` 时，脚本会让扫描到的 UTS 插件直接依赖 `uniapp/Core`，不需要单独启用 UTS 模块：

```ruby
uniapp_subspecs = [
  'Core',
]
```

3. 执行：

```sh
pod install
```

执行时脚本会自动扫描 `UTSPlugins`，为每个插件生成本地 Pod，并处理插件 `app-ios` 下的 `src`、`Frameworks`、`Libs`、`Resources`、`Info.plist`、`UTS.entitlements` 和 `config.json` 中的部分配置。

如果插件 `config.json` 中包含 `{$appid}` 这类占位符，可在 `uniapp_config.rb` 的 `UNIAPP_UTS_PLUGIN_VALUES` 中按插件名填写对应值。

如需验证流程，可复制示例插件：

```sh
cp -R UTSPlugins-Sample/uni-uts-offline-sample UTSPlugins/
pod install
```

证书/Profile、三方平台后台配置、插件自定义业务初始化代码仍需按插件说明处理。

## 16. 常见问题

### 已经在 Info.plist 里写了权限，会被覆盖吗？

不会。权限文案只在缺失时自动补充，已有值不会被覆盖。

### 修改了 Podfile 或 uniapp_config.rb 后要做什么？

重新执行：

```sh
pod install --no-repo-update
```

### 为什么有些模块需要填写 appid，有些不用？

只有依赖第三方平台的模块通常才需要填写，例如微信支付、支付宝、高德地图、友盟统计、广告渠道等。普通基础能力如扫码、相机、文件、蓝牙通常不需要 appid。

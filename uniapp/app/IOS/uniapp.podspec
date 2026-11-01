Pod::Spec.new do |s|
  s.name = 'uniapp'
  s.version = '5.26.0'
  s.summary = 'DCloud uni-app offline iOS SDK local pod.'
  s.homepage = 'https://dcloud.io/'
  s.license = { :type => 'DCloud', :file => 'license.md' }
  s.author = { 'DCloud' => 'https://dcloud.io/' }
  s.source = { :path => '.' }
  s.platform = :ios, '13.0'
  s.default_subspec = 'Core'

  lib = ->(*names) { names.flatten.map { |name| "SDK/Libs/#{name}" } }
  res = ->(*names) { names.flatten.map { |name| "SDK/Bundles/#{name}" } }

  ad_system_frameworks = [
    'Accelerate', 'AdSupport', 'AudioToolbox', 'AVFoundation', 'CoreGraphics', 'CoreImage',
    'CoreLocation', 'CoreMotion', 'CoreMedia', 'CoreTelephony', 'CoreText', 'ImageIO',
    'JavaScriptCore', 'MapKit', 'MediaPlayer', 'MobileCoreServices', 'QuartzCore', 'Security',
    'StoreKit', 'SystemConfiguration', 'UIKit', 'WebKit', 'DeviceCheck', 'CoreML', 'CoreHaptics'
  ]
  ad_libraries = ['bz2', 'c++', 'iconv', 'resolv.9', 'sqlite3', 'xml2', 'z', 'c++abi']

  s.subspec 'Core' do |ss|
    ss.public_header_files = 'SDK/inc/**/*.{h,hpp}'
    ss.source_files = 'SDK/inc/**/*.{h,hpp}'
    ss.vendored_frameworks = lib.call(
      'DCUniBase.framework', 'DCloudUTSFoundation.framework', 'DCloudUTSExtAPI.xcframework'
    )
    ss.vendored_libraries = lib.call(
      'liblibCache.a', 'liblibNavigator.a', 'liblibNativeUI.a', 'liblibNativeObj.a',
      'liblibPGInvocation.a', 'liblibStorage.a', 'liblibUI.a'
    )
    ss.resources = res.call(
      'PandoraApi.bundle', '__uniappes6.js', 'uni-jsframework-dev.js', 'uni-jsframework.js',
      'uni-jsframework-vue3.js', 'uni-jsframework-vue3-dev.js', 'weexUniJs.js',
      'weex-polyfill.js', 'unincomponents.ttf'
    ) + ['SDK/PrivacyInfo.xcprivacy']
    ss.frameworks = [
      'CoreText', 'JavaScriptCore', 'WebKit', 'CoreTelephony', 'MobileCoreServices',
      'SystemConfiguration', 'MediaPlayer', 'AudioToolbox', 'QuartzCore', 'CFNetwork',
      'Foundation', 'CoreFoundation', 'CoreGraphics', 'UIKit', 'AVFoundation',
      'AssetsLibrary', 'AddressBook', 'CoreLocation', 'QuickLook', 'UserNotifications'
    ]
    ss.libraries = ['c++', 'iconv']
    ss.pod_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/SDK/inc" "${PODS_TARGET_SRCROOT}/SDK/inc/**"'
    }
    ss.user_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_ROOT}/Headers/Public/uniapp" "${PODS_ROOT}/Headers/Public/uniapp/**"'
    }
  end

  s.subspec 'Accelerometer' do |ss|
    ss.vendored_libraries = lib.call('liblibAccelerometer.a')
    ss.frameworks = 'Accelerate'
  end

  s.subspec 'Audio' do |ss|
    ss.vendored_libraries = lib.call('liblibMedia.a', 'libopencore-amrnb.a', 'libmp3lame.a')
    ss.vendored_frameworks = lib.call('DCUniRecord.framework')
    ss.frameworks = 'AVFoundation'
  end

  s.subspec 'CameraGallery' do |ss|
    ss.vendored_libraries = lib.call('liblibCamera.a')
    ss.resources = res.call('DCTZImagePickerController.bundle', 'DCMediaEditingController.bundle')
    ss.frameworks = ['AssetsLibrary', 'Accelerate', 'Photos', 'CoreMedia', 'MetalKit', 'GLKit']
  end

  s.subspec 'Contacts' do |ss|
    ss.vendored_libraries = lib.call('liblibContacts.a')
    ss.frameworks = ['AddressBookUI', 'AddressBook', 'AVFoundation', 'CoreVideo', 'CoreMedia']
  end

  s.subspec 'File' do |ss|
    ss.vendored_libraries = lib.call('liblibIO.a')
  end

  s.subspec 'Messaging' do |ss|
    ss.vendored_libraries = lib.call('liblibMessage.a')
    ss.frameworks = 'MessageUI'
  end

  s.subspec 'Orientation' do |ss|
    ss.vendored_libraries = lib.call('liblibOrientation.a')
    ss.frameworks = ['CoreLocation', 'CoreMotion']
  end

  s.subspec 'Proximity' do |ss|
    ss.vendored_libraries = lib.call('liblibPGProximity.a')
  end

  s.subspec 'XMLHttpRequest' do |ss|
    ss.vendored_libraries = lib.call('liblibXHR.a')
  end

  s.subspec 'Zip' do |ss|
    ss.vendored_libraries = lib.call('liblibZip.a')
  end

  s.subspec 'Barcode' do |ss|
    ss.vendored_libraries = lib.call('liblibBarcode.a', 'libDCUniBarcode.a', 'libDCUniZXing.a', 'libuchardet.a')
    ss.frameworks = ['AVFoundation', 'ImageIO', 'CoreVideo', 'CoreMedia']
    ss.libraries = 'iconv.2'
  end

  s.subspec 'Canvas' do |ss|
    ss.vendored_libraries = lib.call('libDCUniCanvas.a')
    ss.frameworks = 'OpenGLES'
  end

  s.subspec 'Video' do |ss|
    ss.vendored_libraries = lib.call('libDCUniVideo.a', 'liblibVideo.a')
    ss.vendored_frameworks = lib.call('DCUniVideoPublic.framework', 'IJKMediaFrameworkWithSSL.framework', 'Masonry.framework')
    ss.resources = res.call('DCSVProgressHUD.bundle', 'DCPGVideo.bundle')
    ss.frameworks = ['AudioToolbox', 'AVFoundation', 'CoreGraphics', 'CoreMedia', 'CoreVideo', 'VideoToolbox', 'MediaPlayer', 'MobileCoreServices', 'OpenGLES', 'QuartzCore', 'UIKit']
    ss.libraries = ['c++', 'bz2', 'z']
  end

  s.subspec 'Fingerprint' do |ss|
    ss.vendored_libraries = lib.call('liblibFingerprint.a')
    ss.frameworks = 'LocalAuthentication'
  end

  s.subspec 'FaceId' do |ss|
    ss.vendored_libraries = lib.call('libDCUniFaceID.a')
    ss.frameworks = 'LocalAuthentication'
  end

  s.subspec 'BlueTooth' do |ss|
    ss.vendored_libraries = lib.call('liblibBlueTooth.a')
    ss.frameworks = 'CoreBluetooth'
  end

  s.subspec 'Sqlite' do |ss|
    ss.vendored_libraries = lib.call('liblibSqlite.a')
    ss.libraries = 'sqlite3.0'
  end

  s.subspec 'IBeacon' do |ss|
    ss.vendored_libraries = lib.call('liblibBeacon.a')
    ss.frameworks = ['CoreBluetooth', 'CoreLocation']
  end

  s.subspec 'Log' do |ss|
    ss.vendored_libraries = lib.call('liblibLog.a')
  end

  s.subspec 'Geolocation' do |ss|
    ss.vendored_libraries = lib.call('liblibGeolocation.a')
    ss.frameworks = ['Foundation', 'CoreLocation']
  end

  s.subspec 'Geolocation-Baidu' do |ss|
    ss.vendored_libraries = lib.call('libBaiduLocationPlugin.a', 'libBaiduKeyVerify.a', 'libssl.a', 'libcrypto.a')
    ss.vendored_frameworks = lib.call('BaiduMapAPI_Utils.framework', 'BaiduMapAPI_Base.framework', 'BaiduMapAPI_Search.framework', 'BMKLocationKit.framework')
    ss.frameworks = ['SystemConfiguration', 'Security', 'CoreLocation', 'CoreTelephony']
    ss.libraries = ['c++', 'sqlite3.0']
    ss.dependency 'uniapp/Geolocation'
  end

  s.subspec 'Geolocation-Gaode' do |ss|
    ss.vendored_libraries = lib.call('libAMapLocationPlugin.a')
    ss.vendored_frameworks = lib.call('AMapFoundationKit.framework', 'AMapLocationKit.framework')
    ss.frameworks = ['ExternalAccessory', 'GLKit', 'Security', 'CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['c++', 'z']
    ss.dependency 'uniapp/Geolocation'
  end

  s.subspec 'Geolocation-Tencent' do |ss|
    ss.vendored_frameworks = lib.call('uniGetLocationTencentUni1.framework', 'TencentLBS.framework')
    ss.frameworks = ['CoreLocation', 'CoreTelephony', 'SystemConfiguration']
    ss.libraries = 'z'
    ss.dependency 'uniapp/Geolocation'
    ss.dependency 'uniapp/Core'
    ss.pod_target_xcconfig = {
      'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64'
    }
    ss.user_target_xcconfig = {
      'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64'
    }
  end

  # UTS plugins are exposed as separate modules so consumers can opt in to
  # their precompiled frameworks without enabling the legacy native modules.
  s.subspec 'UTS-getLocation-tencent-uni1' do |ss|
    ss.vendored_frameworks = lib.call('uniGetLocationTencentUni1.framework', 'TencentLBS.framework')
    ss.frameworks = ['CoreLocation', 'CoreTelephony', 'SystemConfiguration']
    ss.libraries = 'z'
    ss.dependency 'uniapp/Core'
  end

  s.subspec 'UTS-chooseMedia' do |ss|
    ss.vendored_frameworks = lib.call('uniChooseMedia.framework')
    ss.frameworks = ['AVFoundation', 'CoreMedia', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers']
    ss.dependency 'uniapp/Core'
  end

  s.subspec 'Map-Baidu' do |ss|
    ss.vendored_libraries = lib.call('liblibMap.a', 'libbmapimp.a', 'libBaiduKeyVerify.a', 'libssl.a', 'libcrypto.a')
    ss.vendored_frameworks = lib.call('BaiduMapAPI_Utils.framework', 'BaiduMapAPI_Base.framework', 'BaiduMapAPI_Search.framework', 'BaiduMapAPI_Map.framework', 'BMKLocationKit.framework')
    ss.resources = res.call('mapapi.bundle')
    ss.frameworks = ['QuartzCore', 'CoreGraphics', 'CoreTelephony', 'Accelerate', 'SystemConfiguration', 'Security', 'MapKit', 'OpenGLES', 'CoreLocation']
    ss.libraries = ['c++', 'sqlite3.0', 'z']
  end

  s.subspec 'Map-Gaode' do |ss|
    ss.vendored_libraries = lib.call('liblibMap.a', 'libAMapImp.a', 'libDCUniMap.a', 'libDCUniAmap.a')
    ss.vendored_frameworks = lib.call('AMapSearchKit.framework', 'MAMapKit.framework', 'AMapFoundationKit.framework', 'Masonry.framework')
    ss.resources = res.call('AMap.bundle', 'userPosition@2x.png')
    ss.frameworks = ['MapKit', 'CoreLocation', 'GLKit']
    ss.libraries = 'c++'
  end

  s.subspec 'Map-Google' do |ss|
    ss.vendored_libraries = lib.call('libDCUniMap.a', 'libDCUniGoogleMap.a', 'liblibMap.a')
    ss.vendored_frameworks = lib.call('GoogleMapsBase.framework', 'GoogleMaps.framework', 'GoogleMapsCore.framework')
    ss.resources = res.call('GoogleMaps.bundle')
    ss.frameworks = ['Accelerate', 'CoreData', 'CoreGraphics', 'CoreImage', 'CoreLocation', 'CoreTelephony', 'CoreText', 'GLKit', 'ImageIO', 'Metal', 'OpenGLES', 'QuartzCore', 'SystemConfiguration']
    ss.libraries = ['c++', 'z']
  end

  s.subspec 'Oauth' do |ss|
    ss.vendored_libraries = lib.call('liblibOauth.a')
  end

  s.subspec 'Oauth-Univerify' do |ss|
    ss.vendored_frameworks = lib.call('UniVerify.framework', 'GTCommonSDK.xcframework', 'GeYanSdk.xcframework')
    ss.resources = res.call('TYRZResource.bundle')
    ss.frameworks = 'AdSupport'
    ss.libraries = ['z', 'c++', 'sqlite3.0']
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Sina' do |ss|
    ss.vendored_libraries = lib.call('libSinaWBOauth.a', 'libWeiboSDK.a')
    ss.resources = res.call('WeiboSDK.bundle')
    ss.frameworks = 'ImageIO'
    ss.libraries = 'sqlite3.0'
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-QQ' do |ss|
    ss.vendored_libraries = lib.call('libQQOauth.a')
    ss.vendored_frameworks = lib.call('TencentOpenAPI.xcframework')
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Wechat' do |ss|
    ss.vendored_libraries = lib.call('libWXOauth.a', 'libWeChatSDK.a')
    ss.frameworks = ['CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Wechat-PaySDK' do |ss|
    ss.vendored_libraries = lib.call('libWXOauth.a', 'libWeChatSDK_pay.a')
    ss.frameworks = ['CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Apple' do |ss|
    ss.vendored_libraries = lib.call('libAppleOauth.a')
    ss.weak_frameworks = 'AuthenticationServices'
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Google' do |ss|
    ss.vendored_libraries = lib.call('libGoogleOauth.a')
    ss.vendored_frameworks = lib.call('GoogleSignIn.xcframework', 'AppAuth.xcframework', 'GTMAppAuth.xcframework', 'GTMSessionFetcher.xcframework')
    ss.resources = res.call('GoogleSignIn.bundle')
    ss.frameworks = ['CoreText', 'CoreGraphics', 'LocalAuthentication', 'SafariServices', 'Security']
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Oauth-Facebook' do |ss|
    ss.vendored_libraries = lib.call('libFBOauth.a')
    ss.vendored_frameworks = lib.call('FBSDKCoreKit.xcframework', 'FBAEMKit.xcframework', 'FBSDKCoreKit_Basics.xcframework', 'FBSDKLoginKit.xcframework')
    ss.frameworks = ['Accelerate', 'Accounts', 'AdSupport', 'AudioToolbox', 'CoreGraphics', 'QuartzCore', 'Security', 'Social', 'StoreKit']
    ss.libraries = 'c++'
    ss.dependency 'uniapp/Oauth'
  end

  s.subspec 'Payment' do |ss|
    ss.vendored_libraries = lib.call('liblibPayment.a')
  end

  s.subspec 'Payment-AliPay' do |ss|
    ss.vendored_libraries = lib.call('libalixpayment.a')
    ss.vendored_frameworks = lib.call('AlipaySDK.xcframework')
    ss.resources = res.call('AlipaySDK.bundle')
    ss.frameworks = ['Security', 'CoreMotion', 'SystemConfiguration', 'CFNetwork']
    ss.libraries = 'c++'
    ss.dependency 'uniapp/Payment'
  end

  s.subspec 'Payment-Wechat' do |ss|
    ss.vendored_libraries = lib.call('libwxpay.a', 'libWeChatSDK_pay.a')
    ss.frameworks = ['CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'uniapp/Payment'
  end

  s.subspec 'Payment-IAP' do |ss|
    ss.vendored_libraries = lib.call('libIAPPay.a')
    ss.frameworks = 'StoreKit'
    ss.dependency 'uniapp/Payment'
  end

  s.subspec 'Payment-Paypal' do |ss|
    ss.vendored_libraries = lib.call('libpaypalpay.a')
    ss.vendored_frameworks = lib.call('PayPalCheckout.xcframework')
    ss.dependency 'uniapp/Payment'
  end

  s.subspec 'Payment-Stripe' do |ss|
    ss.vendored_libraries = lib.call('libstripepay.a')
    ss.vendored_frameworks = lib.call('StripeApplePay.xcframework', 'StripeCore.xcframework', 'StripeUICore.xcframework', 'Stripe3DS2.xcframework', 'StripePayments.xcframework', 'StripePaymentsUI.xcframework', 'StripePaymentSheet.xcframework')
    ss.dependency 'uniapp/Payment'
  end

  s.subspec 'Push' do |ss|
    ss.vendored_libraries = lib.call('liblibPush.a')
  end

  s.subspec 'Push-UniPush' do |ss|
    ss.vendored_libraries = lib.call('libUniPush.a')
    ss.vendored_frameworks = lib.call('GTSDK.xcframework')
    ss.frameworks = ['Security', 'MobileCoreServices', 'SystemConfiguration', 'CoreLocation', 'AVFoundation', 'CoreTelephony']
    ss.weak_frameworks = 'UserNotifications'
    ss.libraries = ['c++', 'sqlite3', 'z', 'resolv']
    ss.dependency 'uniapp/Push'
  end

  s.subspec 'Push-Getui' do |ss|
    ss.vendored_libraries = lib.call('libGeTuiPush.a')
    ss.vendored_frameworks = lib.call('GTSDK.xcframework')
    ss.frameworks = ['Security', 'MobileCoreServices', 'SystemConfiguration', 'CoreLocation', 'AVFoundation', 'CoreTelephony']
    ss.weak_frameworks = 'UserNotifications'
    ss.libraries = ['c++', 'sqlite3', 'z', 'resolv']
    ss.dependency 'uniapp/Push'
  end

  s.subspec 'Push-FCM' do |ss|
    ss.vendored_libraries = lib.call('libFCMPush.a')
    ss.vendored_frameworks = lib.call('FirebaseCore.xcframework', 'FirebaseCoreInternal.xcframework', 'FirebaseInstallations.xcframework', 'GoogleDataTransport.xcframework', 'GoogleUtilities.xcframework', 'FBLPromises.xcframework', 'nanopb.xcframework', 'FirebaseMessaging.xcframework')
    ss.frameworks = 'UserNotifications'
    ss.dependency 'uniapp/Push'
  end

  s.subspec 'Share' do |ss|
    ss.vendored_libraries = lib.call('liblibShare.a')
  end

  s.subspec 'Share-Sina' do |ss|
    ss.vendored_libraries = lib.call('libSinaShare.a', 'libWeiboSDK.a')
    ss.resources = res.call('WeiboSDK.bundle')
    ss.frameworks = 'ImageIO'
    ss.libraries = 'sqlite3.0'
    ss.dependency 'uniapp/Share'
  end

  s.subspec 'Share-QQ' do |ss|
    ss.vendored_libraries = lib.call('libQQShare.a')
    ss.vendored_frameworks = lib.call('TencentOpenAPI.xcframework')
    ss.dependency 'uniapp/Share'
  end

  s.subspec 'Share-Wechat' do |ss|
    ss.vendored_libraries = lib.call('libweixinShare.a', 'libWeChatSDK.a')
    ss.frameworks = ['CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'uniapp/Share'
  end

  s.subspec 'Share-Wechat-PaySDK' do |ss|
    ss.vendored_libraries = lib.call('libweixinShare.a', 'libWeChatSDK_pay.a')
    ss.frameworks = ['CoreTelephony', 'SystemConfiguration']
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'uniapp/Share'
  end

  s.subspec 'Speech' do |ss|
    ss.vendored_libraries = lib.call('liblibSpeech.a')
  end

  s.subspec 'Speech-Baidu' do |ss|
    ss.vendored_libraries = lib.call('libBaiduSpeechSDK.a', 'libbaiduSpeech.a')
    ss.resources = res.call('BDSClientEASRResources')
    ss.frameworks = ['AudioToolbox', 'AVFoundation', 'CFNetwork', 'CoreLocation', 'CoreTelephony', 'SystemConfiguration', 'GLKit']
    ss.libraries = ['c++', 'z', 'sqlite3']
    ss.dependency 'uniapp/Speech'
  end

  s.subspec 'Speech-Ifly' do |ss|
    ss.vendored_libraries = lib.call('libiflySpeech.a')
    ss.vendored_frameworks = lib.call('iflyMSC.framework')
    ss.frameworks = ['AVFoundation', 'AddressBook', 'Contacts']
    ss.dependency 'uniapp/Speech'
  end

  s.subspec 'LivePusher' do |ss|
    ss.vendored_libraries = lib.call('liblibLivePush.a', 'libDCUniGPUImage.a', 'libDCUniLivePush.a')
    ss.vendored_frameworks = lib.call('UPLiveSDKDll.framework')
    ss.frameworks = ['AVFoundation', 'QuartzCore', 'OpenGLES', 'AudioToolbox', 'VideoToolbox', 'Accelerate', 'CoreMedia', 'CoreTelephony', 'SystemConfiguration', 'CoreMotion']
    ss.libraries = ['z', 'bz2', 'iconv']
  end

  s.subspec 'Statistic' do |ss|
    ss.vendored_libraries = lib.call('liblibStatistic.a')
  end

  s.subspec 'Statistic-Umeng' do |ss|
    ss.vendored_libraries = lib.call('libUmengStatistic.a')
    ss.vendored_frameworks = lib.call('UMDevice.xcframework', 'UMCommon.xcframework', 'UMAPM.xcframework')
    ss.frameworks = ['SystemConfiguration', 'CoreTelephony']
    ss.libraries = ['z', 'sqlite3']
    ss.dependency 'uniapp/Statistic'
  end

  s.subspec 'Statistic-Firebase' do |ss|
    ss.vendored_libraries = lib.call('libGoogleStatistic.a')
    ss.vendored_frameworks = lib.call('FirebaseAnalytics.xcframework', 'FirebaseCore.xcframework', 'FirebaseCoreInternal.xcframework', 'FirebaseInstallations.xcframework', 'GoogleAppMeasurement.xcframework', 'GoogleAppMeasurementIdentitySupport.xcframework', 'GoogleUtilities.xcframework', 'FBLPromises.xcframework', 'nanopb.xcframework')
    ss.dependency 'uniapp/Statistic'
  end

  s.subspec 'UIWebview' do |ss|
    ss.vendored_libraries = lib.call('libH5WEUIWebview.a')
    ss.frameworks = ['JavaScriptCore', 'Foundation', 'UIKit']
  end

  s.subspec 'FacialRecognitionVerify' do |ss|
    ss.vendored_frameworks = lib.call('uniFacialRecognitionVerify.framework', 'AliyunFaceAuthFacade.framework', 'AliyunMobileRPC.framework', 'AliyunOSSiOS.framework', 'APBToygerFacade.framework', 'APPSecuritySDK.framework', 'BioAuthAPI.framework', 'BioAuthEngine.framework', 'deviceiOS.framework', 'DTFIdentityManager.framework', 'DTFSensorServices.framework', 'DTFUIModule.framework', 'DTFUtility.framework', 'MPRemoteLogging.framework', 'ToygerNative.framework', 'ToygerService.framework')
    ss.dependency 'uniapp/Core'
    ss.resources = res.call('APBToygerFacade.bundle', 'BioAuthEngine.bundle', 'ToygerNative.bundle')
    ss.frameworks = ['CoreGraphics', 'Accelerate', 'SystemConfiguration', 'AssetsLibrary', 'CoreTelephony', 'QuartzCore', 'CoreFoundation', 'CoreLocation', 'ImageIO', 'CoreMedia', 'CoreMotion', 'AVFoundation', 'WebKit', 'AudioToolbox', 'CFNetwork', 'MobileCoreServices', 'AdSupport']
    ss.libraries = ['resolv', 'z', 'c++', 'c++.1', 'c++abi', 'z.1.2.8']
  end

  s.subspec 'UniAd-Base' do |ss|
    ss.vendored_libraries = lib.call('libDCUniAdWeexModule.a')
  end

  s.subspec 'UniAd-CSJ' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdCsj.xcframework')
    ss.frameworks = ad_system_frameworks
    ss.libraries = ad_libraries
    ss.dependency 'Ads-CN-Beta/BUAdSDK', '7.6.0.4'
    ss.dependency 'Ads-CN-Beta/CSJMediation-Only', '7.6.0.4'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Gromore' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdGm.xcframework')
    ss.frameworks = ad_system_frameworks
    ss.libraries = ad_libraries
    ss.dependency 'Ads-CN-Beta/BUAdSDK', '7.6.0.4'
    ss.dependency 'Ads-CN-Beta/CSJMediation-Only', '7.6.0.4'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-GDT' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdGdt.xcframework')
    ss.frameworks = ['AdSupport', 'CoreLocation', 'QuartzCore', 'SystemConfiguration', 'CoreTelephony', 'Security', 'StoreKit', 'AVFoundation', 'WebKit', 'JavaScriptCore']
    ss.libraries = ['z', 'c++', 'xml2', 'sqlite3']
    ss.dependency 'GDTMobSDK', '4.15.90'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-KS' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdKs.xcframework')
    ss.frameworks = ['Foundation', 'UIKit', 'MobileCoreServices', 'CoreGraphics', 'Security', 'SystemConfiguration', 'CoreTelephony', 'AdSupport', 'CoreData', 'StoreKit', 'AVFoundation', 'MediaPlayer', 'CoreMedia', 'WebKit', 'Accelerate', 'CoreLocation', 'AVKit', 'MessageUI', 'QuickLook', 'AddressBook', 'CoreMotion']
    ss.libraries = ['z', 'resolv.9', 'sqlite3', 'c++', 'c++abi']
    ss.dependency 'KSAdSDK', '5.4.10.1'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Sigmob' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdSgm.xcframework')
    ss.frameworks = ['StoreKit', 'CFNetwork', 'CoreMedia', 'AdSupport', 'CoreGraphics', 'AVFoundation', 'CoreLocation', 'CoreTelephony', 'SafariServices', 'MobileCoreServices', 'WebKit', 'SystemConfiguration', 'ImageIO']
    ss.libraries = ['z', 'sqlite3']
    ss.dependency 'SigmobAd-iOS', '4.20.22'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Baidu' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdBd.xcframework')
    ss.frameworks = ['StoreKit', 'SafariServices', 'MessageUI', 'CoreMedia', 'CoreMotion', 'SystemConfiguration', 'CoreLocation', 'CoreTelephony', 'AVFoundation', 'AdSupport', 'WebKit']
    ss.libraries = 'c++'
    ss.dependency 'BaiduMobAdSDK', '10.050'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-WM' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdWm.xcframework')
    ss.frameworks = ['CoreGraphics', 'Security', 'WebKit']
    ss.dependency 'WechatOpenSDK-XCFramework', '2.0.5'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-WA' do |ss|
    ss.vendored_frameworks = lib.call('wmuniad_adpater.xcframework')
    ss.frameworks = 'StoreKit'
    ss.dependency 'AdWangMaiSDK', '7.9.4.35'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-AppLovin' do |ss|
    ss.dependency 'AppLovinSDK', '13.3.1'
    ss.dependency 'GoogleMobileAdsMediationAppLovin', '13.3.1.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-GG' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdGg.xcframework')
    ss.dependency 'Google-Mobile-Ads-SDK', '12.9.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-GG-Pangle' do |ss|
    ss.dependency 'Ads-Global', '7.5.0.7'
    ss.dependency 'GoogleMobileAdsMediationPangle', '7.5.0.7.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-GM-Content' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdGm.xcframework', 'DCUniAdGmDrama.xcframework')
    ss.dependency 'Ads-CN-Beta/BUAdSDK', '7.6.0.4'
    ss.dependency 'Ads-CN-Beta/CSJMediation-Only', '7.6.0.4'
    ss.dependency 'Ads-CN-Beta/BUAdLive', '7.6.0.4'
    ss.dependency 'PangrowthX/shortplay-beta', '2.9.0.5'
    ss.dependency 'TTSDKFramework/LivePull', '1.46.2.7-premium'
    ss.dependency 'TTSDKFramework/Player-SR', '1.46.2.7-premium'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-InMobi' do |ss|
    ss.frameworks = 'WebKit'
    ss.libraries = ['sqlite3.0', 'z']
    ss.dependency 'InMobiSDK', '10.8.6'
    ss.dependency 'GoogleMobileAdsMediationInMobi', '10.8.6.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-IronSource' do |ss|
    ss.dependency 'IronSourceSDK', '8.10.0.0'
    ss.dependency 'GoogleMobileAdsMediationIronSource', '8.10.0.0.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-KS-Content' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdKs.xcframework', 'DCUniAdKsContent.xcframework')
    ss.frameworks = ['Foundation', 'UIKit', 'MobileCoreServices', 'CoreGraphics', 'Security', 'SystemConfiguration', 'CoreTelephony', 'AdSupport', 'CoreData', 'StoreKit', 'AVFoundation', 'MediaPlayer', 'CoreMedia', 'WebKit', 'Accelerate', 'CoreLocation', 'AVKit', 'MessageUI', 'QuickLook']
    ss.libraries = ['z', 'resolv.9', 'sqlite3', 'c++', 'c++abi']
    ss.dependency 'KSAdSDK', '5.4.10.1'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Liftoff' do |ss|
    ss.frameworks = ['AdSupport', 'AudioToolbox', 'AVFoundation', 'CFNetwork', 'CoreGraphics', 'CoreMedia', 'MediaPlayer', 'QuartzCore', 'StoreKit', 'SystemConfiguration']
    ss.libraries = 'z'
    ss.dependency 'VungleAds', '7.5.2'
    ss.dependency 'GoogleMobileAdsMediationVungle', '7.5.2.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Meta' do |ss|
    ss.dependency 'FBAudienceNetwork', '6.20.1'
    ss.dependency 'GoogleMobileAdsMediationFacebook', '6.20.1.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Mintegral' do |ss|
    ss.dependency 'MintegralAdSDK', '7.7.9'
    ss.dependency 'GoogleMobileAdsMediationMintegral', '7.7.9.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Pangle' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdPg.xcframework')
    ss.frameworks = ['StoreKit', 'MobileCoreServices', 'WebKit', 'MediaPlayer', 'CoreMedia', 'AVFoundation', 'CoreTelephony', 'SystemConfiguration', 'CoreMotion', 'AdSupport', 'Accelerate', 'AudioToolbox', 'ImageIO', 'Security', 'JavaScriptCore']
    ss.libraries = ['resolv.9', 'c++', 'c++abi', 'z', 'bz2', 'xml2', 'sqlite3', 'iconv']
    ss.dependency 'Ads-Global', '7.5.0.7'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Unity' do |ss|
    ss.dependency 'UnityAds', '4.16.0'
    ss.dependency 'GoogleMobileAdsMediationUnity', '4.16.0.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-Oct' do |ss|
    ss.vendored_frameworks = lib.call('OctUniAdSDK.xcframework')
    ss.frameworks = 'AdSupport'
    ss.libraries = 'c++'
    ss.dependency 'OctopusSDK', '2.6.5.15'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-FL' do |ss|
    ss.vendored_frameworks = lib.call('FLAdUniAdapter.xcframework')
    ss.frameworks = 'AdSupport'
    ss.dependency 'FLAD', '2.9.0.1.1'
    ss.dependency 'FLAD/FLAdFunLinkAdapter'
    ss.dependency 'FunlinkSDK', '2.9.0.1.0'
    ss.dependency 'uniapp/UniAd-Base'
  end

  s.subspec 'UniAd-YT' do |ss|
    ss.vendored_frameworks = lib.call('DCUniAdYT.xcframework')
    ss.frameworks = 'AdSupport'
    ss.dependency 'YouTuiAdSDK', '2.20.3'
    ss.dependency 'YTRelayFoundation', '1.2.4'
    ss.dependency 'uniapp/UniAd-Base'
  end
end

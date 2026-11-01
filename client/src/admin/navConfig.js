// 管理后台侧栏导航配置。labelKey 复用前台现成 nav.* 文案；icon 须在 ../icons.js 登记过
export const adminNav = [
  { name: 'models', labelKey: 'nav.models', icon: 'SetUp', path: '/models' },
  { name: 'art-styles', labelKey: 'nav.artStyles', icon: 'Picture', path: '/art-styles' },
  { name: 'char-options', labelKey: 'nav.charOptions', icon: 'Avatar', path: '/char-options' },
  { name: 'vendors', labelKey: 'nav.vendors', icon: 'Box', path: '/vendors' },
  { name: 'voices', labelKey: 'nav.voices', icon: 'Microphone', path: '/voices' },
  { name: 'maintenance', labelKey: 'nav.maintenance', icon: 'Tools', path: '/maintenance' },
  { name: 'payments', labelKey: 'nav.payments', icon: 'CreditCard', path: '/payments' },
  { name: 'pricing', labelKey: 'nav.pricing', icon: 'Wallet', path: '/pricing' },
  { name: 'users', labelKey: 'nav.users', icon: 'User', path: '/users' },
  { name: 'job-admin', labelKey: 'nav.jobAdmin', icon: 'Timer', path: '/job-admin' },
  { name: 'video-gen-admin', labelKey: 'nav.videoGenAdmin', icon: 'VideoPlay', path: '/video-gen-admin' },
  { name: 'showcase-admin', labelKey: 'nav.showcaseAdmin', icon: 'View', path: '/showcase-admin' },
  { name: 'logs', labelKey: 'nav.logs', icon: 'Document', path: '/logs' },
];

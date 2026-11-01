// 应用 locale → Element Plus 组件 locale 的映射
// Element Plus 自带的语言包，用于日期选择器、分页等内置组件文案
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import zhTw from 'element-plus/es/locale/lang/zh-tw';
import en from 'element-plus/es/locale/lang/en';
import ja from 'element-plus/es/locale/lang/ja';
import ko from 'element-plus/es/locale/lang/ko';
import ru from 'element-plus/es/locale/lang/ru';
import es from 'element-plus/es/locale/lang/es';
import fr from 'element-plus/es/locale/lang/fr';
import ptBr from 'element-plus/es/locale/lang/pt-br';

export const elementLocaleMap = {
  'zh-CN': zhCn,
  'zh-TW': zhTw,
  en,
  ja,
  ko,
  ru,
  es,
  fr,
  pt: ptBr,
};

export default elementLocaleMap;

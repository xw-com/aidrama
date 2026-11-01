// Element Plus 图标按需注册。
// 项目里图标大量以字符串形式引用（导航 icon: 'HomeFilled'、<component :is="kindIcon()">、
// prefix-icon="'Lock'" 等），无法被构建工具静态分析，因此不能靠 unplugin 自动按需，
// 只能显式登记。全量注册约 210KB，本名单约 80 个、仅几十 KB。
// ⚠️ 新增图标时必须把名字加进下面的 import 与列表，否则不会渲染（且无构建报错）。
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Avatar, Bell, Box, Brush, CaretBottom, CreditCard,
  ChatDotRound, Check, CircleCheckFilled, CircleClose, Close, Collection, Comment, Crop,
  DArrowLeft, DArrowRight, DataLine, Delete, Document, DocumentChecked, DocumentCopy,
  Download, Edit, EditPen, Expand, Files, Film, FolderOpened, Fold, FullScreen, GoldMedal,
  Headset, Hide, HomeFilled, InfoFilled, Iphone, Key, Loading, Lock, MagicStick, Message,
  Microphone, Monitor, Moon, MoreFilled, Mute, Picture, PictureFilled, Plus, Promotion,
  QuestionFilled, Reading, Refresh, RefreshLeft, RefreshRight, Right, Scissor, Search,
  Select, Sell, SetUp, Setting, Share, Star, Sunny, Switch, SwitchButton, Tickets, Timer,
  Tools, Upload, User, VideoPause, VideoPlay, View, Wallet, WarningFilled, ZoomIn,
} from '@element-plus/icons-vue';

export function registerIcons(app) {
  for (const [key, comp] of Object.entries({
    ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Avatar, Bell, Box, Brush, CaretBottom, CreditCard,
    ChatDotRound, Check, CircleCheckFilled, CircleClose, Close, Collection, Comment, Crop,
    DArrowLeft, DArrowRight, DataLine, Delete, Document, DocumentChecked, DocumentCopy,
    Download, Edit, EditPen, Expand, Files, Film, FolderOpened, Fold, FullScreen, GoldMedal,
    Headset, Hide, HomeFilled, InfoFilled, Iphone, Key, Loading, Lock, MagicStick, Message,
    Microphone, Monitor, Moon, MoreFilled, Mute, Picture, PictureFilled, Plus, Promotion,
    QuestionFilled, Reading, Refresh, RefreshLeft, RefreshRight, Right, Scissor, Search,
    Select, Sell, SetUp, Setting, Share, Star, Sunny, Switch, SwitchButton, Tickets, Timer,
    Tools, Upload, User, VideoPause, VideoPlay, View, Wallet, WarningFilled, ZoomIn,
  })) {
    app.component(key, comp);
  }
}

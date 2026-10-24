/**
 * 应用入口：挂载 React 根组件，配置 Ant Design 中文语言包
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

/** 全局主题：与 global.css 的设计令牌保持一致（主色 / 圆角 / 字体） */
const theme = {
  token: {
    colorPrimary: '#1677ff',
    colorInfo: '#1677ff',
    borderRadius: 10,
    borderRadiusLG: 14,
    controlHeight: 36,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    colorText: 'rgba(9, 20, 38, 0.88)',
    colorTextSecondary: 'rgba(9, 20, 38, 0.55)',
    boxShadowSecondary: '0 16px 40px -18px rgba(15, 35, 80, 0.28)',
  },
  components: {
    Layout: {
      headerBg: 'transparent',
      bodyBg: 'transparent',
      footerBg: 'transparent',
    },
    Card: { borderRadiusLG: 14, headerFontSize: 15 },
    Menu: { itemBorderRadius: 10, itemMarginInline: 2 },
    Button: { borderRadius: 10, fontWeight: 500 },
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);

/**
 * 页面布局组件：顶部导航栏 + 内容区 + 页脚
 * 使用 Ant Design Layout + Menu，菜单项对应四个功能入口，点击跳转对应路由
 */
import type { ReactNode } from 'react';
import { Layout as AntdLayout, Menu } from 'antd';
import {
  EditOutlined,
  FileTextOutlined,
  HomeOutlined,
  MessageOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';

/** 导航菜单项：key 即路由路径 */
const menuItems = [
  { key: '/', icon: <HomeOutlined />, label: '首页' },
  { key: '/qa', icon: <MessageOutlined />, label: '文档问答' },
  { key: '/summary', icon: <FileTextOutlined />, label: '文档摘要' },
  { key: '/convert', icon: <SwapOutlined />, label: 'PDF 转 Word' },
  { key: '/generate', icon: <EditOutlined />, label: '大纲生成' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  // 根据当前路径高亮菜单项：/qa → /qa，/ → /（无匹配时不高亮）
  const selectedKey = '/' + (location.pathname.split('/')[1] || '');

  return (
    <AntdLayout style={{ minHeight: '100vh' }}>
      <AntdLayout.Header
        style={{ display: 'flex', alignItems: 'center', paddingInline: 24 }}
      >
        <div
          style={{
            color: '#fff',
            fontSize: 18,
            fontWeight: 600,
            marginRight: 32,
            whiteSpace: 'nowrap',
          }}
        >
          AI 文档处理工作台
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </AntdLayout.Header>
      <AntdLayout.Content style={{ padding: 24 }}>
        {children}
      </AntdLayout.Content>
      <AntdLayout.Footer style={{ textAlign: 'center' }}>
        AI 文档处理工作台 ©{new Date().getFullYear()}
      </AntdLayout.Footer>
    </AntdLayout>
  );
}

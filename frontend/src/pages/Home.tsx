/**
 * 首页：项目介绍 + 四个功能入口卡片
 * 功能：问答 / 摘要 / PDF→Word 转换 / 大纲生成
 */
import { Card, Col, Row } from 'antd';
import {
  EditOutlined,
  FileTextOutlined,
  MessageOutlined,
  RightOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

/** 功能入口配置：key 即路由路径，color 为图标语义色（统一在此处定义） */
const features = [
  {
    key: '/qa',
    icon: <MessageOutlined />,
    title: '文档问答',
    desc: '上传 PDF / Word 文档后直接提问，AI 基于文档内容回答，并标注引用片段。',
    color: '#1677ff',
  },
  {
    key: '/summary',
    icon: <FileTextOutlined />,
    title: '文档摘要',
    desc: '一键生成文档核心观点摘要，快速把握长文档重点。',
    color: '#52c41a',
  },
  {
    key: '/convert',
    icon: <SwapOutlined />,
    title: 'PDF 转 Word',
    desc: '文字版 PDF 转换为可编辑 Word，段落与排版基本保留。',
    color: '#fa8c16',
  },
  {
    key: '/generate',
    icon: <EditOutlined />,
    title: '大纲生成',
    desc: '输入标题与大纲要点，AI 自动生成格式规范的完整 Word 文档。',
    color: '#722ed1',
  },
];

export default function Home() {
  const navigate = useNavigate();

  return (
    <div>
      {/* 项目介绍 */}
      <div className="home-page__intro">
        <h2 className="page-title">AI 文档处理工作台</h2>
        <p className="text-secondary">
          面向学生和白领的一站式 AI 文档工具：文档问答、智能摘要、PDF 转
          Word、大纲生成，点击下方卡片开始使用。
        </p>
      </div>

      {/* 四个功能入口卡片 */}
      <Row gutter={[24, 24]}>
        {features.map((f) => (
          <Col key={f.key} xs={24} sm={12} lg={6}>
            <Card className="glass-card home-page__card" onClick={() => navigate(f.key)}>
              <div
                className="home-page__icon"
                style={{ background: `${f.color}1a`, color: f.color }}
              >
                {f.icon}
              </div>
              <div className="home-page__title">{f.title}</div>
              <div className="home-page__desc">{f.desc}</div>
              <div className="home-page__link">
                立即使用 <RightOutlined />
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}

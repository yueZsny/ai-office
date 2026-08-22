/**
 * 应用路由配置
 * 路由：/（首页）、/qa（问答）、/summary（摘要）、/convert（转换）、/generate（生成）
 */
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import QaPage from './pages/QaPage';
import SummaryPage from './pages/SummaryPage';
import ConvertPage from './pages/ConvertPage';
import GeneratePage from './pages/GeneratePage';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/qa" element={<QaPage />} />
          <Route path="/summary" element={<SummaryPage />} />
          <Route path="/convert" element={<ConvertPage />} />
          <Route path="/generate" element={<GeneratePage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

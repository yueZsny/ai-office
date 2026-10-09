/**
 * LLM 供应商编辑弹窗（新增/编辑 + 弹窗内测试连接）
 * - 受控 Input（与 GeneratePage 一致，不用 antd Form）
 * - 编辑态 apiKey 留空 = 不修改（placeholder 展示已存打码 key，后端复用旧值）
 * - 测试连接用当前表单值（编辑态空 key 由后端取已存值），结果内联展示
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { createLlmProvider, testLlmProvider, updateLlmProvider } from '../api';
import type { LlmProviderPublic, LlmSettings, LlmTestResult } from '../api';

interface Props {
  open: boolean;
  /** 编辑对象；null = 新增 */
  editing: LlmProviderPublic | null;
  onCancel: () => void;
  /** 保存成功（后端返回全量 settings，父组件一次 setState） */
  onSaved: (settings: LlmSettings) => void;
}

export default function LlmProviderModal({ open, editing, onCancel, onSaved }: Props) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  // 打开/切换编辑对象时重置表单
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setApiKey(''); // 编辑态留空 = 不修改
    setBaseUrl(editing?.baseUrl ?? '');
    setModel(editing?.model ?? '');
    setTestResult(null);
  }, [open, editing]);

  const trimmedKey = apiKey.trim();

  const handleTest = async () => {
    if (!baseUrl.trim() || !model.trim() || (!editing && !trimmedKey)) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        model: model.trim() || '-',
        message: '请先填写 API Key、Base URL 和模型名',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testLlmProvider({
        providerId: editing?.id,
        apiKey: trimmedKey || undefined, // 编辑态留空 → 后端用已存 key
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim() };
      const settings = editing
        ? await updateLlmProvider(editing.id, trimmedKey ? { ...payload, apiKey: trimmedKey } : payload)
        : await createLlmProvider({ ...payload, apiKey: trimmedKey });
      onSaved(settings);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? '编辑供应商' : '添加供应商'}
      onCancel={onCancel}
      width={520}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="test" loading={testing} onClick={handleTest}>
          测试连接
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          disabled={
            !name.trim() || !baseUrl.trim() || !model.trim() || (!editing && !trimmedKey)
          }
          onClick={handleSave}
        >
          保存
        </Button>,
      ]}
    >
      <div className="form-item">
        <label className="form-label">名称</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：DeepSeek 官方"
          maxLength={64}
        />
      </div>
      <div className="form-item">
        <label className="form-label">API Key</label>
        <Input.Password
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            editing ? `已保存（${editing.apiKeyMasked}），留空表示不修改` : 'sk-...'
          }
          autoComplete="off"
        />
      </div>
      <div className="form-item">
        <label className="form-label">Base URL（OpenAI 兼容接口地址）</label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1"
        />
      </div>
      <div className="form-item">
        <label className="form-label">模型名</label>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-chat"
          maxLength={64}
        />
      </div>

      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          message={
            testResult.ok
              ? `连接成功 · ${testResult.latencyMs}ms`
              : `连接失败：${testResult.message}`
          }
        />
      )}
    </Modal>
  );
}

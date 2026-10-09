/**
 * 模型设置页：配置 LLM 供应商（API key / base_url / 模型名），
 * 并指定主模型（问答/摘要/文档生成）与大纲模型（思维导图）两个槽位
 * - 所有变更端点返回全量设置，一次 setState 同步列表与槽位
 * - 保存后即时生效（ai-service 读 Redis，无需重启）
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Popconfirm, Select, Tag, Tooltip } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  deleteLlmProvider,
  getLlmEffective,
  getLlmSettings,
  testLlmProvider,
  updateLlmSlots,
} from '../api';
import type {
  LlmEffective,
  LlmProviderPublic,
  LlmSettings,
  LlmTestResult,
} from '../api';
import LlmProviderModal from '../components/LlmProviderModal';

export default function SettingsPage() {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [effective, setEffective] = useState<LlmEffective | null>(null);

  // 槽位草稿（保存后才生效；dirty 时启用保存按钮）
  const [mainId, setMainId] = useState<string | null>(null);
  const [outlineId, setOutlineId] = useState<string | null>(null);
  const [savingSlots, setSavingSlots] = useState(false);

  // 供应商弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProviderPublic | null>(null);

  // 行内测试连接
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmTestResult>>({});

  const refreshEffective = useCallback(async () => {
    setEffective(await getLlmEffective());
  }, []);

  useEffect(() => {
    getLlmSettings().then((s) => {
      setSettings(s);
      setMainId(s.mainProviderId);
      setOutlineId(s.outlineProviderId);
    });
    refreshEffective();
  }, [refreshEffective]);

  /** 全量设置落地：列表 + 槽位草稿一次同步 */
  const applySettings = (s: LlmSettings) => {
    setSettings(s);
    setMainId(s.mainProviderId);
    setOutlineId(s.outlineProviderId);
  };

  const handleSaved = (s: LlmSettings) => {
    applySettings(s);
    setModalOpen(false);
    setEditing(null);
    refreshEffective();
  };

  const handleDelete = async (id: string) => {
    const s = await deleteLlmProvider(id);
    applySettings(s);
    refreshEffective();
  };

  const handleSaveSlots = async () => {
    setSavingSlots(true);
    try {
      const s = await updateLlmSlots({ mainProviderId: mainId, outlineProviderId: outlineId });
      applySettings(s);
      refreshEffective();
    } finally {
      setSavingSlots(false);
    }
  };

  /** 行内测试连接（复用已存配置）；再次点击清除上次结果 */
  const handleTest = async (p: LlmProviderPublic) => {
    setTestingId(p.id);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    try {
      const result = await testLlmProvider({ providerId: p.id });
      setTestResults((prev) => ({ ...prev, [p.id]: result }));
    } finally {
      setTestingId(null);
    }
  };

  const slotsDirty =
    settings !== null && (mainId !== settings.mainProviderId || outlineId !== settings.outlineProviderId);

  const providerOptions =
    settings?.providers.map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` })) ?? [];

  return (
    <div>
      <h2 className="page-title">模型设置</h2>

      <Card className="glass-card" title="生效模型" style={{ marginBottom: 24 }}>
        <p className="text-secondary">
          主模型用于问答、摘要与文档生成；大纲模型用于思维导图提纲（可选用便宜模型）。
          保存后即时生效，无需重启服务。
        </p>

        <div className="form-item">
          <label className="form-label">主模型</label>
          <Select
            style={{ width: 360 }}
            value={mainId ?? undefined}
            options={providerOptions}
            allowClear
            placeholder="未指定（使用 ai-service 环境变量默认配置）"
            onChange={(v) => setMainId(v ?? null)}
          />
        </div>
        <div className="form-item">
          <label className="form-label">大纲模型</label>
          <Select
            style={{ width: 360 }}
            value={outlineId ?? undefined}
            options={providerOptions}
            allowClear
            placeholder="跟随主模型"
            onChange={(v) => setOutlineId(v ?? null)}
          />
        </div>

        {effective && !effective.available && (
          <p className="text-secondary">{effective.message ?? 'AI 服务不可用，无法读取生效配置'}</p>
        )}
        {effective?.available && effective.main && (
          <p className="settings-page__effective">
            当前生效 · 主模型：{effective.main.model}
            {effective.source === 'db' && effective.main.providerName
              ? `（${effective.main.providerName}）`
              : '（来自环境变量）'}
            ；大纲模型：{effective.outline?.fallbackToMain
              ? '跟随主模型'
              : `${effective.outline?.model}${effective.outline?.providerName ? `（${effective.outline.providerName}）` : ''}`}
          </p>
        )}

        <div className="page-actions" style={{ justifyContent: 'flex-start' }}>
          <Button
            type="primary"
            disabled={!slotsDirty}
            loading={savingSlots}
            onClick={handleSaveSlots}
          >
            保存
          </Button>
        </div>
      </Card>

      <Card
        className="glass-card"
        title="供应商配置"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            添加供应商
          </Button>
        }
      >
        {!settings || settings.providers.length === 0 ? (
          <Empty description="尚未添加供应商，当前使用 ai-service 环境变量中的默认模型" />
        ) : (
          settings.providers.map((p) => (
            <div key={p.id} className="settings-page__provider">
              <div className="settings-page__provider-main">
                <span className="settings-page__provider-name">{p.name}</span>
                {settings.mainProviderId === p.id && <Tag color="blue">主模型</Tag>}
                {settings.outlineProviderId === p.id && <Tag color="purple">大纲模型</Tag>}
              </div>
              <div className="settings-page__provider-meta">
                <Tooltip title={p.baseUrl}>
                  <span className="settings-page__provider-url">{p.baseUrl}</span>
                </Tooltip>
                <span>模型：{p.model}</span>
                <span className="settings-page__provider-key">Key：{p.apiKeyMasked}</span>
              </div>
              <div className="settings-page__provider-actions">
                <Button
                  size="small"
                  loading={testingId === p.id}
                  onClick={() => handleTest(p)}
                >
                  测试连接
                </Button>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(p);
                    setTestResults((prev) => {
                      const next = { ...prev };
                      delete next[p.id];
                      return next;
                    });
                    setModalOpen(true);
                  }}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="删除该供应商？"
                  description="引用它的槽位将自动清空"
                  onConfirm={() => handleDelete(p.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </div>
              {testResults[p.id] && (
                <Alert
                  style={{ marginTop: 8 }}
                  type={testResults[p.id].ok ? 'success' : 'error'}
                  showIcon
                  message={
                    testResults[p.id].ok
                      ? `连接成功 · ${testResults[p.id].latencyMs}ms`
                      : `连接失败：${testResults[p.id].message}`
                  }
                />
              )}
            </div>
          ))
        )}
      </Card>

      <LlmProviderModal
        open={modalOpen}
        editing={editing}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSaved={handleSaved}
      />
    </div>
  );
}

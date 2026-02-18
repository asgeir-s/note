import { useState, useEffect, useCallback } from "react";
import { listInputDevices } from "./api";
import type { ToolStatus, InputDeviceInfo, ModelSettings, OllamaModelInfo, WhisperModelInfo } from "./api";

export interface PullProgress {
  model: string;
  status: string;
  percent: number | null;
}

interface SettingsPanelProps {
  toolStatus: ToolStatus;
  recordingDevice: string | null;
  onDeviceChange: (device: string | null) => void;
  onRefreshTools: () => void;
  onClose: () => void;
  modelSettings: ModelSettings;
  ollamaModels: OllamaModelInfo[];
  whisperModels: WhisperModelInfo[];
  onModelSettingsChange: (settings: ModelSettings) => void;
  onPullModel: (name: string) => Promise<void>;
  pullProgress: PullProgress | null;
}

const TOOLS = [
  { key: "git" as const, label: "git", description: "Version control & sync", command: "xcode-select --install" },
  { key: "ffmpeg" as const, label: "ffmpeg", description: "Audio processing", command: "brew install ffmpeg" },
  { key: "whisper" as const, label: "whisper-cli", description: "Speech transcription", command: "brew install whisper-cpp" },
  { key: "ollama" as const, label: "ollama", description: "AI tagging & summaries", command: "brew install ollama" },
  { key: "qmd" as const, label: "qmd", description: "Related notes search", command: "npm install -g @tobilu/qmd" },
];

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export function SettingsPanel({
  toolStatus,
  recordingDevice,
  onDeviceChange,
  onRefreshTools,
  onClose,
  modelSettings,
  ollamaModels,
  whisperModels,
  onModelSettingsChange,
  onPullModel,
  pullProgress,
}: SettingsPanelProps) {
  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
  const [pullingModel, setPullingModel] = useState<string | null>(null);

  useEffect(() => {
    listInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  // Escape and click-outside to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      onDeviceChange(value === "" ? null : value);
    },
    [onDeviceChange],
  );

  const handleOllamaModelChange = useCallback(
    (field: "keyword_model" | "summary_model") => (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value || null;
      onModelSettingsChange({ ...modelSettings, [field]: value });
    },
    [modelSettings, onModelSettingsChange],
  );

  const handleWhisperModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value || null;
      onModelSettingsChange({ ...modelSettings, whisper_model: value });
    },
    [modelSettings, onModelSettingsChange],
  );

  const handlePullModel = useCallback(async (name: string) => {
    setPullingModel(name);
    try {
      await onPullModel(name);
    } finally {
      setPullingModel(null);
    }
  }, [onPullModel]);

  const installedOllama = ollamaModels.filter(m => m.installed);
  const uninstalledOllama = ollamaModels.filter(m => !m.installed);

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-section">
          <div className="settings-section-title">Recording Device</div>
          <select
            className="settings-device-select"
            value={recordingDevice ?? ""}
            onChange={handleSelectChange}
          >
            <option value="">Auto-detect</option>
            {devices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}{d.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Models</div>

          <label className="settings-model-label">Keywords model (ollama)</label>
          <select
            className="settings-device-select"
            value={modelSettings.keyword_model ?? ""}
            onChange={handleOllamaModelChange("keyword_model")}
          >
            <option value="">Auto-detect</option>
            {installedOllama.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.size_bytes ? ` (${formatSize(m.size_bytes)})` : ""}
              </option>
            ))}
          </select>

          <label className="settings-model-label">Summary model (ollama)</label>
          <select
            className="settings-device-select"
            value={modelSettings.summary_model ?? ""}
            onChange={handleOllamaModelChange("summary_model")}
          >
            <option value="">Auto-detect</option>
            {installedOllama.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.size_bytes ? ` (${formatSize(m.size_bytes)})` : ""}
              </option>
            ))}
          </select>

          <label className="settings-model-label">Transcription model (whisper)</label>
          <select
            className="settings-device-select"
            value={modelSettings.whisper_model ?? ""}
            onChange={handleWhisperModelChange}
          >
            <option value="">Auto-detect</option>
            {whisperModels.map((m) => (
              <option key={m.path} value={m.name}>
                {m.name} ({formatSize(m.size_bytes)})
              </option>
            ))}
          </select>

          {uninstalledOllama.length > 0 && (
            <div className="settings-model-recommended">
              <div className="settings-model-recommended-title">Recommended ollama models</div>
              {uninstalledOllama.map((m) => (
                <div key={m.name} className="settings-model-row">
                  <span className="settings-model-name">{m.name}</span>
                  <span className="settings-model-size">
                    {m.parameter_size ?? ""}{m.size_bytes ? ` · ${formatSize(m.size_bytes)}` : ""}
                  </span>
                  {pullingModel === m.name && pullProgress?.model === m.name ? (
                    <div className="settings-model-progress">
                      <div className="settings-model-progress-text">
                        {pullProgress.percent !== null
                          ? `Downloading... ${pullProgress.percent}%`
                          : pullProgress.status}
                      </div>
                      {pullProgress.percent !== null && (
                        <div className="settings-model-progress-bar">
                          <div
                            className="settings-model-progress-fill"
                            style={{ width: `${pullProgress.percent}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      className="settings-model-install-btn"
                      disabled={pullingModel !== null}
                      onClick={() => handlePullModel(m.name)}
                    >
                      {pullingModel === m.name ? "Installing..." : "Install"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {TOOLS.some((t) => !toolStatus[t.key]) && (
          <div className="settings-section">
            <div className="settings-section-title">
              Missing Tools
              <button className="settings-refresh-btn" onClick={onRefreshTools}>
                Refresh
              </button>
            </div>
            {TOOLS.filter((t) => !toolStatus[t.key]).map((tool) => (
              <div key={tool.key} className="settings-tool-row">
                <div className="settings-tool-info">
                  <span className="settings-tool-name">{tool.label}</span>
                  <span className="settings-tool-desc">{tool.description}</span>
                </div>
                <code className="settings-install-cmd">{tool.command}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

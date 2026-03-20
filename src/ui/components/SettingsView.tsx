import { useState, useEffect, useCallback } from 'preact/hooks';
import type { LocalSettings } from '../types.js';
import { api } from '../api.js';

export function SettingsView() {
  const [settings, setSettings] = useState<LocalSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dirInput, setDirInput] = useState('');

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getSettings();
      setSettings(data);
      setDirInput(data.privateWorkflowsDir || '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const updated = await api.updateSettings({
        privateWorkflowsDir: dirInput.trim() || null,
        privateWorkflowsEnabled: settings.privateWorkflowsEnabled,
      });
      setSettings(updated);
      setSuccess('Settings saved successfully. Refresh workflows to see changes.');
      setTimeout(() => setSuccess(null), 5000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const updated = await api.updateSettings({
        ...settings,
        privateWorkflowsEnabled: enabled,
      });
      setSettings(updated);
      setSuccess(enabled ? 'Private workflows enabled.' : 'Private workflows disabled.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSafeExecute = async (enabled: boolean) => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const updated = await api.updateSettings({
        ...settings,
        safeExecute: enabled,
      });
      setSettings(updated);
      setSuccess(
        enabled
          ? 'Safe Execute enabled. Restart Symphony to apply. If Docker is not running at startup, Symphony will fall back to non-Docker mode.'
          : 'Safe Execute disabled. Restart Symphony to apply.'
      );
      setTimeout(() => setSuccess(null), 6000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="animate-pulse">
          <div className="h-8 rounded w-1/4 mb-6" style={{ background: 'var(--bg-tertiary)' }}></div>
          <div className="h-32 rounded" style={{ background: 'var(--bg-tertiary)' }}></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto h-full overflow-y-auto">
      <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--text-primary)' }}>Settings</h2>

      {error && (
        <div className="mb-4 p-3 rounded-md" style={{ background: 'var(--accent-red-bg)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)' }}>
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 rounded-md" style={{ background: 'var(--accent-green-bg)', border: '1px solid var(--accent-green)', color: 'var(--accent-green)' }}>
          {success}
        </div>
      )}

      <div className="rounded-lg p-6 mb-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-sm)' }}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Safe Execute</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
          Run OpenCode inside a Docker container with access restricted to the workspace directory only.
          This prevents agents from reading or writing files outside the designated workspace.
          Requires Docker to be installed and running. If Docker is unavailable at startup, Symphony
          falls back to non-Docker mode automatically.
        </p>

        <div className="flex items-center justify-between">
          <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Enable Safe Execute
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={settings.safeExecute ?? false}
            onClick={() => handleToggleSafeExecute(!settings.safeExecute)}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              settings.safeExecute ? 'bg-blue-600' : ''
            } ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={!settings.safeExecute ? { background: 'var(--bg-tertiary)' } : undefined}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.safeExecute ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          Changes take effect on the next Symphony restart.
          Override the Docker image via the <code className="px-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>SYMPHONY_OPENCODE_DOCKER_IMAGE</code> environment variable.
        </p>
      </div>

      <div className="rounded-lg p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-sm)' }}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Private Workflows</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
          Load workflows from a private directory that is not checked into git.
          Private workflows will be marked with a lock icon.
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Enable Private Workflows
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.privateWorkflowsEnabled ?? false}
              onClick={() => handleToggleEnabled(!settings.privateWorkflowsEnabled)}
              disabled={saving}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                settings.privateWorkflowsEnabled ? 'bg-blue-600' : ''
              } ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
              style={!settings.privateWorkflowsEnabled ? { background: 'var(--bg-tertiary)' } : undefined}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.privateWorkflowsEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div>
            <label htmlFor="privateWorkflowsDir" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
              Private Workflows Directory
            </label>
            <input
              type="text"
              id="privateWorkflowsDir"
              value={dirInput}
              onChange={(e) => setDirInput((e.target as HTMLInputElement).value)}
              placeholder="/path/to/private/workflows"
              disabled={saving}
              className="w-full px-3 py-2 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-primary)',
              }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Directory should contain a <code className="px-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>workflows.json</code> file
              and workflow template files (<code className="px-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>.md</code>).
            </p>
          </div>

          <div className="pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-4 py-2 bg-blue-600 text-white rounded-md font-medium transition-colors ${
                saving ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'
              }`}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

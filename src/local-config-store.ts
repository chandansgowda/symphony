import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from './logger.js';

const log = new Logger('local-config');

export interface LocalConfig {
  privateWorkflowsDir?: string | null;
  privateWorkflowsEnabled?: boolean;
  workflowBadgeMode?: 'dot' | 'border';
  theme?: 'system' | 'light' | 'dark';
  safeExecute?: boolean;
}

const DEFAULT_CONFIG: LocalConfig = {
  privateWorkflowsDir: null,
  privateWorkflowsEnabled: false,
  workflowBadgeMode: 'dot',
  theme: 'system',
  safeExecute: false,
};

export class LocalConfigStore {
  private configPath: string;
  private cachedConfig: LocalConfig | null = null;

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, 'local-config.json');
  }

  updateDataDir(dataDir: string): void {
    const newPath = path.join(dataDir, 'local-config.json');
    if (newPath !== this.configPath) {
      this.configPath = newPath;
      this.cachedConfig = null;
    }
  }

  async getConfig(): Promise<LocalConfig> {
    if (this.cachedConfig) {
      // Always apply current defaults to ensure new config fields are included
      // even if the cache was populated by an older version of the code
      return { ...DEFAULT_CONFIG, ...this.cachedConfig };
    }

    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content) as LocalConfig;
      this.cachedConfig = { ...DEFAULT_CONFIG, ...config };
      log.debug('Loaded local config', { path: this.configPath });
      return this.cachedConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.debug('No local config file found, using defaults', { path: this.configPath });
        this.cachedConfig = { ...DEFAULT_CONFIG };
        return this.cachedConfig;
      }
      log.warn('Failed to read local config', { error: (err as Error).message });
      this.cachedConfig = { ...DEFAULT_CONFIG };
      return this.cachedConfig;
    }
  }

  async updateConfig(updates: Partial<LocalConfig>): Promise<LocalConfig> {
    const current = await this.getConfig();
    const updated: LocalConfig = { ...current, ...updates };

    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(this.configPath, JSON.stringify(updated, null, 2), 'utf-8');
    this.cachedConfig = updated;
    
    log.info('Updated local config', { 
      privateWorkflowsDir: updated.privateWorkflowsDir,
      privateWorkflowsEnabled: updated.privateWorkflowsEnabled,
      workflowBadgeMode: updated.workflowBadgeMode,
      theme: updated.theme,
      safeExecute: updated.safeExecute,
    });
    
    return updated;
  }

  clearCache(): void {
    this.cachedConfig = null;
  }

  async getPrivateWorkflowsDir(): Promise<string | null> {
    const config = await this.getConfig();
    
    if (!config.privateWorkflowsEnabled || !config.privateWorkflowsDir) {
      return null;
    }

    let dir = config.privateWorkflowsDir;
    if (dir.startsWith('~')) {
      const os = await import('node:os');
      dir = path.join(os.homedir(), dir.slice(1));
    }

    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) {
        log.warn('Private workflows path is not a directory', { path: dir });
        return null;
      }
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.debug('Private workflows directory does not exist', { path: dir });
      } else {
        log.warn('Failed to access private workflows directory', { 
          path: dir, 
          error: (err as Error).message 
        });
      }
      return null;
    }
  }
}

/**
 * Resource monitor: polls system metrics and alerts #master
 * when thresholds are crossed. Runs as a background loop in
 * the NanoClaw host process.
 */

import os from 'os';
import { execSync } from 'child_process';
import { logger } from './logger.js';
import { MAX_CONCURRENT_CONTAINERS } from './config.js';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Thresholds: alert when crossed, clear when dropped below
const THRESHOLDS = {
  memoryPercent: { alert: 80, clear: 70 },
  diskPercent: { alert: 80, clear: 70 },
  containerPercent: { alert: 80, clear: 60 },
};

// Track which alerts are active (don't spam)
const activeAlerts = new Set<string>();

interface SystemMetrics {
  memoryPercent: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  diskPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  containerCount: number;
  containerMax: number;
}

function getMetrics(getActiveContainers: () => number): SystemMetrics {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let diskPercent = 0;
  let diskUsedGB = 0;
  let diskTotalGB = 0;
  try {
    const df = execSync('df /home --output=pcent,used,size | tail -1', {
      encoding: 'utf-8',
    }).trim();
    const parts = df.split(/\s+/);
    diskPercent = parseInt(parts[0]) || 0;
    diskUsedGB = (parseInt(parts[1]) || 0) / (1024 * 1024);
    diskTotalGB = (parseInt(parts[2]) || 0) / (1024 * 1024);
  } catch {
    /* ignore df failures */
  }

  return {
    memoryPercent: Math.round((usedMem / totalMem) * 100),
    memoryUsedGB: +(usedMem / 1024 ** 3).toFixed(1),
    memoryTotalGB: +(totalMem / 1024 ** 3).toFixed(1),
    diskPercent,
    diskUsedGB: +diskUsedGB.toFixed(1),
    diskTotalGB: +diskTotalGB.toFixed(1),
    containerCount: getActiveContainers(),
    containerMax: MAX_CONCURRENT_CONTAINERS,
  };
}

function checkThresholds(
  metrics: SystemMetrics,
  sendAlert: (text: string) => Promise<void>,
): void {
  // Memory
  checkMetric(
    'memory',
    metrics.memoryPercent,
    THRESHOLDS.memoryPercent,
    `⚠️ Memory at ${metrics.memoryPercent}% (${metrics.memoryUsedGB}/${metrics.memoryTotalGB} GB). Consider destroying idle workers.`,
    `✅ Memory back to ${metrics.memoryPercent}%.`,
    sendAlert,
  );

  // Disk
  checkMetric(
    'disk',
    metrics.diskPercent,
    THRESHOLDS.diskPercent,
    `⚠️ Disk at ${metrics.diskPercent}% (${metrics.diskUsedGB}/${metrics.diskTotalGB} GB).`,
    `✅ Disk back to ${metrics.diskPercent}%.`,
    sendAlert,
  );

  // Containers
  const containerPercent = Math.round(
    (metrics.containerCount / metrics.containerMax) * 100,
  );
  checkMetric(
    'containers',
    containerPercent,
    THRESHOLDS.containerPercent,
    `⚠️ Containers at ${metrics.containerCount}/${metrics.containerMax}.`,
    `✅ Containers back to ${metrics.containerCount}/${metrics.containerMax}.`,
    sendAlert,
  );
}

function checkMetric(
  name: string,
  value: number,
  threshold: { alert: number; clear: number },
  alertMsg: string,
  clearMsg: string,
  sendAlert: (text: string) => Promise<void>,
): void {
  if (value >= threshold.alert && !activeAlerts.has(name)) {
    activeAlerts.add(name);
    logger.warn({ name, value }, 'Resource alert triggered');
    sendAlert(alertMsg).catch(() => {});
  } else if (value < threshold.clear && activeAlerts.has(name)) {
    activeAlerts.delete(name);
    logger.info({ name, value }, 'Resource alert cleared');
    sendAlert(clearMsg).catch(() => {});
  }
}

export function startResourceMonitor(
  masterJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
  getActiveContainers: () => number,
): void {
  const poll = () => {
    try {
      const metrics = getMetrics(getActiveContainers);
      checkThresholds(metrics, (text) => sendMessage(masterJid, text));
    } catch (err) {
      logger.error({ err }, 'Resource monitor error');
    }
  };

  // First check after 30s (let everything start up)
  setTimeout(poll, 30_000);
  setInterval(poll, POLL_INTERVAL);
  logger.info('Resource monitor started (5 min interval)');
}

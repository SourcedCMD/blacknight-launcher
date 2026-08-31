'use strict';
const os = require('os');
const fs = require('fs');

/**
 * Reads what this machine actually has, so the store can answer "will it run?"
 * instead of printing a requirements table and leaving the player to guess.
 *
 * The probe is cached: CPU and memory never change while the launcher is open,
 * and the GPU query costs a real round trip into the GPU process. Free space
 * is the one moving part, so it is read fresh on every call.
 */
class Hardware {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    this.cached = null;
  }

  /** Trims the marketing noise off a CPU model string. */
  static tidyCpu(model) {
    return String(model || '')
      .replace(/\((R|TM)\)/gi, '')
      .replace(/\bCPU\b/gi, '')
      .replace(/@.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Electron reports every adapter it knows about. Pick the one most likely to
   * run the game: a discrete card over an integrated one.
   */
  static pickGpu(info) {
    const devices = info?.gpuDevice || [];
    if (!devices.length) return null;

    const named = devices
      .map((d) => d.deviceString || d.driverVendor || '')
      .filter(Boolean);
    if (!named.length) return null;

    const discrete = named.find((name) => /geforce|gtx|rtx|radeon|\brx\b|arc\s*[ab]\d/i.test(name));
    return discrete || named[0];
  }

  async probe() {
    if (!this.cached) {
      let gpu = null;
      try {
        gpu = Hardware.pickGpu(await this.app.getGPUInfo('basic'));
      } catch {
        /* the GPU process can decline; the check reports "unknown" instead */
      }

      const cpus = os.cpus();
      this.cached = {
        os: Hardware.describeOs(),
        platform: process.platform,
        arch: process.arch,
        cpu: Hardware.tidyCpu(cpus[0]?.model),
        cpuCores: cpus.length,
        ramBytes: os.totalmem(),
        gpu
      };
    }

    return { ...this.cached, freeBytes: this.freeSpace() };
  }

  static describeOs() {
    if (process.platform === 'win32') {
      // Windows 11 still reports a 10.x kernel; the build number is what
      // separates them.
      const build = Number(os.release().split('.')[2] || 0);
      return `Windows ${build >= 22000 ? 11 : 10} ${os.arch() === 'x64' ? '64-bit' : os.arch()}`;
    }
    return `${os.type()} ${os.release()}`;
  }

  /** Free bytes on the drive games install to. */
  freeSpace() {
    try {
      const dir = this.settings.get('installDir');
      if (!dir) return null;
      // statfs needs a path that exists; walk up to the nearest one.
      let probe = dir;
      while (probe && !fs.existsSync(probe)) {
        const parent = require('path').dirname(probe);
        if (parent === probe) return null;
        probe = parent;
      }
      const stat = fs.statfsSync(probe);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }
}

module.exports = { Hardware };

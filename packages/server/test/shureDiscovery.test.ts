/**
 * Tests for the Shure Command Strings parsing and host enumeration.
 *
 * Every case here is a regression: this module was ported verbatim from MicWizard
 * before MicWizard found and fixed these, so each one is a bug that shipped in
 * RFutils rather than a hypothetical. They are unit tests because the parsing was
 * pulled out of the socket-handling class specifically so it could be tested
 * without standing up a TCP connection.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFramedMessages,
  parseShureMessage,
  subnetHostsFor,
} from '../src/monitor/discovery/shureProtocol.js';

describe('extractFramedMessages', () => {
  it('parses a single complete message', () => {
    const { messages, remainder } = extractFramedMessages('< REP 1 BATT_CHARGE 087 >');
    expect(messages).toEqual(['REP 1 BATT_CHARGE 087']);
    expect(remainder).toBe('');
  });

  it('parses multiple messages arriving in one chunk', () => {
    const { messages } = extractFramedMessages('< REP 1 ALL >< SAMPLE 1 AUDIO_LVL 054 >');
    expect(messages).toEqual(['REP 1 ALL', 'SAMPLE 1 AUDIO_LVL 054']);
  });

  it('holds an incomplete trailing message for the next chunk', () => {
    const first = extractFramedMessages('< REP 1 ALL >< SAMPLE 1 AUDIO');
    expect(first.messages).toEqual(['REP 1 ALL']);
    expect(first.remainder).toBe('< SAMPLE 1 AUDIO');

    const second = extractFramedMessages(first.remainder + '_LVL 054 >');
    expect(second.messages).toEqual(['SAMPLE 1 AUDIO_LVL 054']);
  });

  it('does not stall forever on a stray ">" before the first "<"', () => {
    // The old loop searched for '>' from the top of the buffer and required
    // end > start, so one leftover '>' made the closing index land before the
    // opening one — the loop exited and never recovered, and every subsequent
    // message on that socket was silently dropped.
    const { messages, remainder } = extractFramedMessages('stray>junk< REP 1 ALL >');
    expect(messages).toEqual(['REP 1 ALL']);
    expect(remainder).toBe('');
  });

  it('drops stray bytes with no "<" pending rather than growing forever', () => {
    const { messages, remainder } = extractFramedMessages('garbage with no brackets');
    expect(messages).toEqual([]);
    expect(remainder).toBe('');
  });
});

describe('parseShureMessage', () => {
  it('parses a REP message into a channel', () => {
    const parsed = parseShureMessage(
      'REP 1 CHAN_NAME Vocal1 BATT_CHARGE 078 BATT_RUN_TIME 312 ANTENNA DIVERSITY',
      'shure:10.0.0.5'
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.channelNum).toBe('1');
    expect(parsed!.channel.id).toBe('shure:10.0.0.5:1');
    expect(parsed!.channel.name).toBe('Vocal1');
    expect(parsed!.channel.batteryPercent).toBe(78);
    expect(parsed!.channel.batteryMinutesRemaining).toBe(312);
    expect(parsed!.channel.antenna).toBe('diversity');
  });

  it('ignores anything that is not a REP or SAMPLE', () => {
    expect(parseShureMessage('NOTE 1 whatever', 'shure:10.0.0.5')).toBeNull();
  });

  it('keeps fields a SAMPLE does not mention', () => {
    // A receiver answers GET ALL with everything, but its periodic SAMPLE carries
    // only the metered fields. Rebuilding the channel from the SAMPLE alone used
    // to blank the name back to "Channel 1" and drop the battery twice a second.
    const full = parseShureMessage(
      'REP 1 CHAN_NAME Lectern BATT_CHARGE 018 BATT_RUN_TIME 046 RF_LVL_A 055 ANTENNA B AUDIO_LVL 054',
      'shure:10.0.0.5'
    );
    const sampled = parseShureMessage(
      'SAMPLE 1 RF_LVL_A 072 AUDIO_LVL 090',
      'shure:10.0.0.5',
      full!.channel
    );

    expect(sampled!.channel.name).toBe('Lectern');
    expect(sampled!.channel.batteryPercent).toBe(18);
    expect(sampled!.channel.batteryMinutesRemaining).toBe(46);
    expect(sampled!.channel.antenna).toBe('B');
    // ...while the metered fields the message did carry do update.
    expect(sampled!.channel.rfLevel).toBe(72);
    expect(sampled!.channel.audioLevelDb).toBe(-10);
  });

  it('lets a field present in the message win over what was known', () => {
    const known = parseShureMessage('REP 1 CHAN_NAME Old BATT_CHARGE 090', 'shure:10.0.0.5');
    const next = parseShureMessage(
      'REP 1 CHAN_NAME New BATT_CHARGE 012',
      'shure:10.0.0.5',
      known!.channel
    );
    expect(next!.channel.name).toBe('New');
    expect(next!.channel.batteryPercent).toBe(12);
  });

  it('still reports null for absent fields when nothing is known yet', () => {
    const parsed = parseShureMessage('SAMPLE 2 AUDIO_LVL 054', 'shure:10.0.0.5');
    expect(parsed!.channel.name).toBe('Channel 2');
    expect(parsed!.channel.batteryPercent).toBeNull();
    expect(parsed!.channel.rfLevel).toBeNull();
  });
});

describe('subnetHostsFor', () => {
  it('sweeps every attached subnet, not just the first', () => {
    // The regression this guards: taking only the first non-internal interface
    // meant a VM bridge (or any VPN) shadowed the real LAN and discovery found
    // nothing at all — on one dev machine the first interface is a Parallels
    // bridge the host has no route to.
    const hosts = subnetHostsFor([
      { family: 'IPv4', address: '10.211.55.2', netmask: '255.255.255.0', internal: false },
      { family: 'IPv4', address: '192.168.1.90', netmask: '255.255.255.0', internal: false },
    ]);
    expect(hosts).toHaveLength(253 * 2);
    expect(hosts).toContain('10.211.55.1');
    expect(hosts).toContain('192.168.1.90');
    expect(hosts).toContain('192.168.1.253');
  });

  it('skips loopback, IPv6 and point-to-point interfaces', () => {
    const hosts = subnetHostsFor([
      { family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
      // A VPN tunnel: a /32 has no neighbours to sweep.
      { family: 'IPv4', address: '100.64.0.1', netmask: '255.255.255.255', internal: false },
    ]);
    expect(hosts).toEqual([]);
  });

  it('does not scan the same /24 twice when two interfaces share it', () => {
    const hosts = subnetHostsFor([
      { family: 'IPv4', address: '192.168.1.90', netmask: '255.255.255.0', internal: false },
      { family: 'IPv4', address: '192.168.1.91', netmask: '255.255.255.0', internal: false },
    ]);
    expect(hosts).toHaveLength(253);
  });
});

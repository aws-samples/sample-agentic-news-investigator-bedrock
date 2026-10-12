import { describe, expect, it } from 'vitest';
import * as names from '../lib/names';

// Every literal the hand-written stack carried before it was parameterised.
// With prefix "fin" and arms "v1" (pipeline), "v2", "v3" the derived names
// must equal these exactly, or an existing deployment would move.
const v1 = { key: 'v1', kind: 'pipeline' as const };
const v2 = { key: 'v2', kind: 'agent' as const };
const v3 = { key: 'v3', kind: 'agent' as const };

describe('names for prefix "fin" reproduce the pre-parameterisation literals', () => {
  it('shared plumbing', () => {
    expect(names.busName('fin')).toBe('fin-events');
    expect(names.busArchiveName('fin')).toBe('fin-events-archive');
    expect(names.coreTableName('fin')).toBe('fin-trading');
    expect(names.coreKillSwitchParam('fin')).toBe('/fin/kill-switch');
    expect(names.alertTopicName('fin')).toBe('fin-alerts');
    expect(names.dashboardName('fin')).toBe('fin-trading');
    expect(names.tapeTableName('fin')).toBe('fin-quote-tape');
  });

  it('pipeline arm (v1) uses the core table and kill switch', () => {
    expect(names.armTableName('fin', v1)).toBe('fin-trading');
    expect(names.armKillSwitchParam('fin', v1)).toBe('/fin/kill-switch');
    expect(names.armResources('fin', v1)).toEqual({
      table: 'fin-trading',
      killSwitchParam: '/fin/kill-switch',
    });
  });

  it('v2', () => {
    expect(names.armTableName('fin', v2)).toBe('fin-v2-trading');
    expect(names.armNewsQueueName('fin', 'v2')).toBe('fin-v2-news');
    expect(names.armNewsDlqName('fin', 'v2')).toBe('fin-v2-news-dlq');
    expect(names.armKillSwitchParam('fin', v2)).toBe('/fin/v2/kill-switch');
    expect(names.armDailyBudgetParam('fin', 'v2')).toBe('/fin/v2/daily-budget-usd');
  });

  it('v3', () => {
    expect(names.armTableName('fin', v3)).toBe('fin-v3-trading');
    expect(names.armNewsQueueName('fin', 'v3')).toBe('fin-v3-news');
    expect(names.armNewsDlqName('fin', 'v3')).toBe('fin-v3-news-dlq');
    expect(names.armKillSwitchParam('fin', v3)).toBe('/fin/v3/kill-switch');
    expect(names.armDailyBudgetParam('fin', 'v3')).toBe('/fin/v3/daily-budget-usd');
  });

  it('armResources is the parity surface for the runtime', () => {
    expect(names.armResources('fin', v2)).toEqual({
      table: 'fin-v2-trading',
      killSwitchParam: '/fin/v2/kill-switch',
      newsQueue: 'fin-v2-news',
      newsDlq: 'fin-v2-news-dlq',
      dailyBudgetParam: '/fin/v2/daily-budget-usd',
    });
  });

  it('replay bench resources are shared and derive from the prefix', () => {
    // Before parameterisation these were fin-v2-replay{,-dlq,-rule}; the
    // shared names are the one accepted replacement.
    expect(names.replayQueueName('fin')).toBe('fin-replay');
    expect(names.replayDlqName('fin')).toBe('fin-replay-dlq');
    expect(names.replayRuleName('fin')).toBe('fin-replay-rule');
    expect(names.workerPolicyName('fin')).toBe('fin-worker');
  });

  it('construct ids match the hand-written stack', () => {
    expect(names.armConstructId('v2', 'Table')).toBe('V2Table');
    expect(names.armConstructId('v2', 'NewsQueue')).toBe('V2NewsQueue');
    expect(names.armConstructId('v2', 'NewsDlq')).toBe('V2NewsDlq');
    expect(names.armConstructId('v2', 'OnNewsItem')).toBe('V2OnNewsItem');
    expect(names.armConstructId('v2', 'KillSwitch')).toBe('V2KillSwitch');
    expect(names.armConstructId('v2', 'DailyBudget')).toBe('V2DailyBudget');
    expect(names.armConstructId('v3', 'Table')).toBe('V3Table');
    expect(names.armConstructPrefix('sonnet-4')).toBe('Sonnet4');
  });
});

describe('another prefix', () => {
  it('derives every name from the prefix', () => {
    const alpha = { key: 'alpha', kind: 'agent' as const };
    expect(names.busName('demo')).toBe('demo-events');
    expect(names.coreTableName('demo')).toBe('demo-trading');
    expect(names.tapeTableName('demo')).toBe('demo-quote-tape');
    expect(names.armTableName('demo', alpha)).toBe('demo-alpha-trading');
    expect(names.armNewsQueueName('demo', 'alpha')).toBe('demo-alpha-news');
    expect(names.armKillSwitchParam('demo', alpha)).toBe('/demo/alpha/kill-switch');
    expect(names.armDailyBudgetParam('demo', 'alpha')).toBe('/demo/alpha/daily-budget-usd');
    expect(names.replayQueueName('demo')).toBe('demo-replay');
  });

  it('rejects prefixes and keys that cannot be embedded in resource names', () => {
    expect(() => names.assertPrefix('Fin')).toThrow();
    expect(() => names.assertPrefix('fin_x')).toThrow();
    expect(() => names.assertPrefix('')).toThrow();
    expect(() => names.assertArmKey('2v')).toThrow();
    expect(names.assertArmKey('v2')).toBe('v2');
  });
});

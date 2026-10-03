import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDailyNoteDetails } from '../services/dailyNote/service.js'

test('绝区零录像店接口枚举以可读中文展示，未知枚举不泄露到图片', () => {
  const details = formatDailyNoteDetails('zzz', {vhs_sale:{sale_state:'SaleStateDoing'}})
  assert.deepEqual(details, [{label:'录像店',value:'营业中'}])
  const unknown = formatDailyNoteDetails('zzz', {vhs_sale:{sale_state:'SaleStateNew'}})
  assert.deepEqual(unknown, [{label:'录像店',value:'状态待确认'}])
  assert.equal(formatDailyNoteDetails('zzz', {vhs_sale:{text:'今日营业已结束'}})[0].value, '今日营业已结束')
})

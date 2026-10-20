import { sourceKinds, sourceLabels, type KingdeeBatch, type SourceKind, type SourceMeta, type SourceReferences } from './kingdee-types';

export type SourceMode = 'api' | 'upload' | 'saved' | 'omit';
export type SourceChoice = { mode: SourceMode; batchId: string };
export type SourceChoices = Record<SourceKind, SourceChoice>;
export type FileInfo = { name: string; size: number };
export type PreparedSource = { kind: SourceKind; mode: SourceMode; name: string; size: number; ready: boolean; status: string; issue: string; batch?: KingdeeBatch; source?: SourceMeta };

export function preparationChoices(batch: KingdeeBatch | null, preset: 'mixed' | 'upload' | 'saved' = 'mixed'): SourceChoices {
  return Object.fromEntries(sourceKinds.map(kind => {
    const available = batch?.state === 'ready' && batch.sources.some(source => source.kind === kind);
    const mode: SourceMode = preset === 'saved' && available ? 'saved' : kind === 'legacy' ? available ? 'saved' : 'omit' : kind === 'prices' && preset === 'mixed' && available ? 'saved' : preset === 'mixed' && (kind === 'companySales' || kind === 'companyStock') ? 'api' : 'upload';
    return [kind, { mode, batchId: available ? batch!.id : '' }];
  })) as SourceChoices;
}

export function assessPreparation(choices: SourceChoices, files: Partial<Record<SourceKind, FileInfo>>, history: KingdeeBatch[]) {
  const rows: PreparedSource[] = sourceKinds.map(kind => {
    const choice = choices[kind];
    const base = { kind, mode: choice.mode, name: '', size: 0, ready: false, status: '', issue: '' };
    if (choice.mode === 'omit') return { ...base, ready: kind === 'legacy', status: '本批不使用', issue: kind === 'legacy' ? '' : '该来源为必需项' };
    if (choice.mode === 'api') return { ...base, status: '接口待联调', issue: '接口尚未接通，请先选择上传Excel或已保存版本' };
    if (choice.mode === 'saved') {
      const batch = history.find(batch => batch.id === choice.batchId && batch.state === 'ready');
      const source = batch?.sources.find(source => source.kind === kind);
      return source ? { ...base, name: source.name, size: source.size, ready: true, status: '已选保存版本', batch, source } : { ...base, status: '未选择版本', issue: '请选择包含该来源的成功批次' };
    }
    const file = files[kind];
    if (!file) return { ...base, status: '未选择文件', issue: '请选择Excel文件' };
    const issue = !/\.xlsx$/i.test(file.name) ? '只支持.xlsx文件' : file.size <= 0 ? '文件为空' : file.size > 32 * 1024 * 1024 ? '单份文件不能超过32MB' : '';
    return { ...base, name: file.name, size: file.size, ready: !issue, status: issue ? '文件不符合要求' : '已选文件，待提交核验', issue };
  });
  const size = rows.reduce((sum, row) => sum + row.size, 0);
  const issues = rows.filter(row => row.issue).map(row => `${sourceLabels[row.kind]}：${row.issue}`);
  if (size > 50 * 1024 * 1024) issues.push('本批上传与复用文件合计不能超过50MB');
  const required = rows.filter(row => row.kind !== 'legacy');
  const references = Object.fromEntries(rows.filter(row => row.mode === 'saved' && row.ready).map(row => [row.kind, row.batch!.id])) as SourceReferences;
  return { rows, size, issues, ready: issues.length === 0, readyCount: required.filter(row => row.ready).length, references };
}

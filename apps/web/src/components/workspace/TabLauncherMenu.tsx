import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Icon, type IconName } from '../Icon';
import type { ProjectFile, ProjectFileKind } from '../../types';
import type { LauncherAction, LauncherContext } from './tab-launcher';
import styles from './TabLauncherMenu.module.css';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface Props {
  /** The "+" button the menu is anchored to (for fixed positioning). */
  anchor: HTMLElement | null;
  /** Project files to search; the caller passes `visibleFiles`. */
  files: ProjectFile[];
  /** Tab names already open, so matching rows can show an "open" marker. */
  openTabNames: string[];
  /** "Create new" actions from the launcher registry (empty in Stage 1). */
  actions: LauncherAction[];
  /** Context the registry actions run against. */
  launcherContext: LauncherContext;
  /** Open the chosen file in a new tab (wired to FileWorkspace.openFile). */
  onOpenFile: (name: string) => void;
  onClose: () => void;
}

// Command-palette dropdown for the tab strip's "+" button. Rendered through a
// portal to document.body with fixed positioning so no ancestor `overflow`
// clips it. Searches the project's files (open in a new tab) and lists any
// registry-driven "Create new" actions (Side Chat / Terminal / Browser land
// here as their stages ship).
export function TabLauncherMenu({
  anchor,
  files,
  openTabNames,
  actions,
  launcherContext,
  onOpenFile,
  onClose,
}: Props) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<ProjectFileKind | 'all'>('all');
  const [selected, setSelected] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position from the anchor's rect; keep it pinned to the button's right edge
  // so the menu hangs under the "+" without spilling off-screen.
  useLayoutEffect(() => {
    if (!anchor) return;
    function update() {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const width = 340;
      const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
      setPos({ top: r.bottom + 6, left });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchor]);

  // Outside-click / Escape to dismiss.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchor?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  // The set of kinds present, in a stable order, for the filter chips.
  const presentKinds = useMemo(() => {
    const seen = new Set<ProjectFileKind>();
    for (const f of files) seen.add(f.kind);
    return [...seen];
  }, [files]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (kindFilter !== 'all' && f.kind !== kindFilter) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q);
    });
  }, [files, query, kindFilter]);

  // Clamp the selection whenever the result set shrinks.
  useEffect(() => {
    setSelected((curr) => (results.length === 0 ? 0 : Math.min(curr, results.length - 1)));
  }, [results.length]);

  // Keep the keyboard-selected row visible as arrow keys move past the
  // scrollable window's edges.
  useEffect(() => {
    const ul = listRef.current;
    const el = ul?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, results.length]);

  const openSet = useMemo(() => new Set(openTabNames), [openTabNames]);

  function chooseFile(name: string) {
    onOpenFile(name);
    onClose();
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => (results.length === 0 ? 0 : (s + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => (results.length === 0 ? 0 : (s - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = results[selected] ?? results[0];
      if (file) {
        chooseFile(file.name);
      } else if (actions[0]) {
        // No file matches the query but "Create new" actions exist — Enter
        // triggers the first action so the keyboard path is never a dead end.
        actions[0].run(launcherContext);
        onClose();
      }
    }
  }

  if (!pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label={t('workspace.newTab')}
      data-testid="tab-launcher-menu"
    >
      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden>
          <Icon name="search" size={15} />
        </span>
        <input
          ref={inputRef}
          autoFocus
          className={styles.searchInput}
          type="text"
          value={query}
          placeholder={t('workspace.searchFilesPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          data-testid="tab-launcher-search"
        />
      </div>

      {presentKinds.length > 0 ? (
        <div className={styles.chips}>
          <button
            type="button"
            className={`${styles.chip} ${kindFilter === 'all' ? styles.chipActive : ''}`}
            onClick={() => setKindFilter('all')}
          >
            {t('workspace.allFiles')}
          </button>
          {presentKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`${styles.chip} ${kindFilter === kind ? styles.chipActive : ''}`}
              onClick={() => setKindFilter(kind)}
            >
              {kindLabel(kind, t)}
            </button>
          ))}
        </div>
      ) : null}

      {actions.length > 0 ? (
        <>
          <div className={styles.sectionHeader}>{t('workspace.createNew')}</div>
          <ul className={styles.list} style={{ maxHeight: 'none', flex: '0 0 auto' }}>
            {actions.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => {
                    action.run(launcherContext);
                    onClose();
                  }}
                >
                  <span className={styles.rowIcon} aria-hidden>
                    <Icon name={action.iconName} size={15} />
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowName}>{t(action.labelKey)}</span>
                    {action.descriptionKey ? (
                      <span className={styles.rowMeta}>{t(action.descriptionKey)}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.sectionHeader}>{t('workspace.openFile')}</div>
        </>
      ) : null}

      {results.length === 0 ? (
        <div className={styles.empty} data-testid="tab-launcher-empty">
          {t('workspace.noFilesMatch')}
        </div>
      ) : (
        <ul className={styles.list} ref={listRef}>
          {results.map((file, index) => {
            const isOpen = openSet.has(file.name);
            return (
              <li key={file.name}>
                <button
                  type="button"
                  className={`${styles.row} ${index === selected ? styles.rowSelected : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => chooseFile(file.name)}
                  data-testid="tab-launcher-result"
                >
                  <span className={styles.rowIcon} aria-hidden>
                    <Icon name={kindIconName(file.kind)} size={15} />
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowName}>{file.name}</span>
                    <span className={styles.rowMeta}>
                      {kindLabel(file.kind, t)} · {formatBytes(file.size)} ·{' '}
                      {formatRelativeTime(file.mtime, t)}
                    </span>
                  </span>
                  {isOpen ? <span className={styles.rowOpen}>{t('workspace.tabOpen')}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}

// --- local helpers ---------------------------------------------------------
// DesignFilesPanel keeps equivalent `humanBytes` / `relativeTime` /
// `kindLabel` helpers but does not export them, so we keep tiny copies here
// (same formatting contract) rather than widening that component's surface.

function kindIconName(kind: ProjectFileKind): IconName {
  if (kind === 'html') return 'file-code';
  if (kind === 'image') return 'image';
  if (kind === 'sketch') return 'pencil';
  if (kind === 'code') return 'file-code';
  return 'file';
}

function kindLabel(kind: ProjectFileKind, t: TranslateFn): string {
  if (kind === 'html') return t('designFiles.kindHtml');
  if (kind === 'image') return t('designFiles.kindImage');
  if (kind === 'sketch') return t('designFiles.kindSketch');
  if (kind === 'text') return t('designFiles.kindText');
  if (kind === 'code') return t('designFiles.kindCode');
  if (kind === 'pdf') return t('designFiles.kindPdf');
  if (kind === 'document') return t('designFiles.kindDocument');
  if (kind === 'presentation') return t('designFiles.kindPresentation');
  if (kind === 'spreadsheet') return t('designFiles.kindSpreadsheet');
  return t('designFiles.kindBinary');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  if (diff < 30 * day) return t('designFiles.weeksAgo', { n: Math.floor(diff / (7 * day)) });
  return new Date(ts).toLocaleDateString();
}

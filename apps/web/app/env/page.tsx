'use client';

import {
  formatDotenv,
  formatShellExport,
  isValidEnvKey,
  maskValue,
  parseDotenv,
} from '@core/shared';
import type { DecryptedEnvVar, DecryptedEnvironment, DecryptedProject } from '@core/shared';
import { Button, Input, Panel, Textarea } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { copySecret, pulse } from '@/lib/client/clipboard';
import { activeProjects, environmentsOf, useEnv, varsOf } from '@/lib/client/env-store';
import { toast } from '@/lib/client/toast-store';
import { startAutoLock, useVault } from '@/lib/client/vault-store';

/**
 * The environment manager.
 *
 * The feature that makes this different from a password manager: a `.env` file
 * is a pile of production secrets that developers keep in plaintext on their
 * laptops, paste into Slack, and email to new starters. Everything here is
 * encrypted in the browser under the same Account Key as the vault, including
 * the variable names.
 *
 * Values are masked by default and revealed one at a time. That is not
 * decoration — the whole screen is a wall of secrets, and the normal reason to
 * open it is to copy one of them while somebody watches you share your screen.
 */

export default function EnvPage() {
  const router = useRouter();

  const state = useVault((vault) => vault.state);
  const lock = useVault((vault) => vault.lock);

  const projects = useEnv((store) => store.projects);
  const environments = useEnv((store) => store.environments);
  const vars = useEnv((store) => store.vars);
  const loading = useEnv((store) => store.loading);
  const error = useEnv((store) => store.error);
  const load = useEnv((store) => store.load);
  const reset = useEnv((store) => store.reset);
  const createProject = useEnv((store) => store.createProject);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState('');

  useEffect(() => startAutoLock(), []);

  useEffect(() => {
    if (state === 'unlocked') void load();
    else reset();
  }, [state, load, reset]);

  const live = useMemo(() => activeProjects(projects), [projects]);
  const openProject = live.find((entry) => entry.id === projectId) ?? live[0];

  const projectEnvironments = useMemo(
    () => (openProject ? environmentsOf(environments, openProject.id) : []),
    [environments, openProject],
  );

  const openEnvironment =
    projectEnvironments.find((entry) => entry.id === environmentId) ?? projectEnvironments[0];

  if (state === 'locked') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
        <Panel>
          <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
            <span className="cursor">core</span>
          </h1>
          <p className="text-muted mt-4 font-mono text-sm" data-testid="env-state">
            <span aria-hidden="true">&gt; </span>
            vault locked
          </p>
          <Button
            type="button"
            onClick={() => router.push('/login')}
            className="mt-8"
            data-testid="go-unlock"
          >
            unlock
          </Button>
        </Panel>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-4xl px-4 pt-8 pb-28 sm:px-6 sm:pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-accent text-glow text-lg font-bold tracking-tight">
          <span className="cursor">core</span>
          <span className="text-muted ml-3 text-xs tracking-widest uppercase">env</span>
        </h1>
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" onClick={() => router.push('/vault')}>
            vault
          </Button>
          <Button type="button" variant="ghost" onClick={() => lock(false)} data-testid="lock">
            lock
          </Button>
        </div>
      </header>

      {error ? (
        <p role="status" className="text-warning mt-4 font-mono text-xs" data-testid="env-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}

      <form
        className="mt-6 flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (newProject.trim() === '') return;
          void createProject(newProject.trim()).then(setProjectId);
          setNewProject('');
        }}
      >
        <Input
          value={newProject}
          onChange={(event) => setNewProject(event.target.value)}
          placeholder="new project"
          aria-label="new project"
          data-testid="project-name"
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={newProject.trim() === ''} data-testid="project-create">
          create
        </Button>
      </form>

      {live.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2" data-testid="project-list">
          {live.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                setProjectId(project.id);
                setEnvironmentId(null);
              }}
              aria-current={openProject?.id === project.id ? 'true' : undefined}
              data-testid="project-chip"
              className={
                openProject?.id === project.id
                  ? 'border-accent text-accent shadow-glow-soft secret border px-2 py-1 font-mono text-xs'
                  : 'border-line text-muted hover:border-accent hover:text-accent secret border px-2 py-1 font-mono text-xs'
              }
            >
              {project.name}
            </button>
          ))}
        </div>
      ) : loading ? (
        <p className="text-muted mt-8 font-mono text-sm">
          <span aria-hidden="true">&gt; </span>
          loading...
        </p>
      ) : (
        <p className="text-muted mt-8 font-mono text-sm" data-testid="env-empty">
          <span aria-hidden="true">&gt; </span>
          no projects yet
        </p>
      )}

      {openProject && openEnvironment ? (
        <ProjectView
          project={openProject}
          environments={projectEnvironments}
          openEnvironment={openEnvironment}
          onSelectEnvironment={setEnvironmentId}
          vars={vars}
        />
      ) : null}
    </main>
  );
}

function ProjectView({
  project,
  environments,
  openEnvironment,
  onSelectEnvironment,
  vars,
}: {
  project: DecryptedProject;
  environments: readonly DecryptedEnvironment[];
  openEnvironment: DecryptedEnvironment;
  onSelectEnvironment: (id: string) => void;
  vars: readonly DecryptedEnvVar[];
}) {
  const deleteProject = useEnv((store) => store.deleteProject);
  const createEnvironment = useEnv((store) => store.createEnvironment);
  const deleteEnvironment = useEnv((store) => store.deleteEnvironment);
  const duplicateEnvironment = useEnv((store) => store.duplicateEnvironment);

  const [newEnvironment, setNewEnvironment] = useState('');
  const rows = useMemo(() => varsOf(vars, openEnvironment.id), [vars, openEnvironment.id]);

  return (
    <section className="mt-8">
      <div className="border-line flex flex-wrap items-center gap-2 border-b pb-3">
        {environments.map((environment) => (
          <button
            key={environment.id}
            type="button"
            onClick={() => onSelectEnvironment(environment.id)}
            aria-current={environment.id === openEnvironment.id ? 'page' : undefined}
            data-testid="environment-tab"
            className={
              environment.id === openEnvironment.id
                ? 'text-accent border-accent secret border-b-2 px-2 pb-2 font-mono text-xs tracking-widest uppercase'
                : 'text-muted hover:text-accent secret border-b-2 border-transparent px-2 pb-2 font-mono text-xs tracking-widest uppercase'
            }
          >
            {environment.name}
          </button>
        ))}

        <form
          className="ml-auto flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (newEnvironment.trim() === '') return;
            void createEnvironment(project.id, newEnvironment.trim()).then(onSelectEnvironment);
            setNewEnvironment('');
          }}
        >
          <Input
            value={newEnvironment}
            onChange={(event) => setNewEnvironment(event.target.value)}
            placeholder="new environment"
            aria-label="new environment"
            data-testid="environment-name"
            className="w-40"
          />
          <Button type="submit" variant="ghost" data-testid="environment-create">
            add
          </Button>
        </form>
      </div>

      <VariableEditor environment={openEnvironment} rows={rows} />

      <footer className="border-line mt-10 flex flex-wrap gap-3 border-t pt-6">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            const name = `${openEnvironment.name}-copy`;
            void duplicateEnvironment(openEnvironment.id, name).then((id) => {
              onSelectEnvironment(id);
              toast(`Copied to ${name}, values and all.`);
            });
          }}
          data-testid="environment-duplicate"
        >
          duplicate environment
        </Button>

        {environments.length > 1 ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              // Confirmed, because this one is not soft: the environment goes
              // and its variables go with it, and there is no trash to fish
              // them back out of.
              const count = rows.length;
              if (
                !window.confirm(
                  `Delete this environment and its ${count} variable(s)? This cannot be undone.`,
                )
              ) {
                return;
              }
              void deleteEnvironment(openEnvironment.id);
            }}
            data-testid="environment-delete"
          >
            delete environment
          </Button>
        ) : null}

        <Button
          type="button"
          variant="danger"
          onClick={() => void deleteProject(project.id)}
          data-testid="project-delete"
        >
          delete project
        </Button>
      </footer>
    </section>
  );
}

function VariableEditor({
  environment,
  rows,
}: {
  environment: DecryptedEnvironment;
  rows: readonly DecryptedEnvVar[];
}) {
  const saveVar = useEnv((store) => store.saveVar);
  const importVars = useEnv((store) => store.importVars);

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [revealAll, setRevealAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState('');

  // Reset when the environment changes, or a half-typed variable follows you
  // into a different environment and gets saved there.
  useEffect(() => {
    setKey('');
    setValue('');
    setRevealAll(false);
    setImporting(false);
    setDragging(false);
    setPaste('');
  }, [environment.id]);

  const keyIsValid = key === '' || isValidEnvKey(key);
  const asParsed = rows.map((row) => ({ key: row.key, value: row.value }));

  async function copyAll(text: string, label: string): Promise<void> {
    const ok = await copySecret(text);
    if (!ok) {
      toast('The browser refused clipboard access.', { tone: 'danger' });
      return;
    }
    pulse();
    toast(`${label} copied. The clipboard clears in 30 seconds.`);
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setRevealAll((current) => !current)}
          aria-pressed={revealAll}
          data-testid="reveal-all"
        >
          {revealAll ? 'mask all' : 'reveal all'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void copyAll(formatDotenv(asParsed), '.env')}
          disabled={rows.length === 0}
          data-testid="copy-dotenv"
        >
          copy .env
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void copyAll(formatShellExport(asParsed), 'shell exports')}
          disabled={rows.length === 0}
          data-testid="copy-shell"
        >
          copy exports
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => download(`${environment.name}.env`, formatDotenv(asParsed))}
          disabled={rows.length === 0}
          data-testid="download-dotenv"
        >
          download
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setImporting((current) => !current)}
          aria-pressed={importing}
          data-testid="open-import"
        >
          import
        </Button>
      </div>

      {importing ? (
        <Panel
          className={dragging ? 'border-accent shadow-glow-soft mt-4' : 'mt-4'}
          // Dropping a file is how a `.env` actually arrives — it is already on
          // disk, and the alternative is opening it in an editor to copy out of.
          onDragOver={(event: React.DragEvent) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: React.DragEvent) => {
            event.preventDefault();
            setDragging(false);

            const file = event.dataTransfer.files[0];
            if (!file) return;

            // Read here rather than uploaded anywhere: the file is a list of
            // production secrets and it never leaves this tab unencrypted.
            void file.text().then(setPaste);
          }}
          data-testid="import-drop"
        >
          <p className="text-muted mb-3 font-mono text-xs">
            <span aria-hidden="true">&gt; </span>
            Paste a .env file, or drop one here. Existing keys are updated; nothing is removed.
          </p>
          <Textarea
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={'DATABASE_URL="postgres://..."\nSTRIPE_SECRET_KEY=sk_live_...'}
            aria-label="paste a dotenv file"
            data-testid="import-text"
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={paste.trim() === ''}
              onClick={() => {
                const parsed = parseDotenv(paste);
                void importVars(environment.id, parsed.vars).then((written) => {
                  toast(
                    parsed.skipped.length > 0
                      ? `${written} imported, ${parsed.skipped.length} line(s) not understood.`
                      : `${written} variable(s) imported.`,
                    parsed.skipped.length > 0 ? { tone: 'warning' } : {},
                  );
                });
                setPaste('');
                setImporting(false);
              }}
              data-testid="import-apply"
            >
              import
            </Button>
            <Button type="button" variant="ghost" onClick={() => setImporting(false)}>
              cancel
            </Button>
          </div>
        </Panel>
      ) : null}

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isValidEnvKey(key)) return;
          void saveVar(environment.id, { key, value });
          setKey('');
          setValue('');
        }}
      >
        <Input
          value={key}
          onChange={(event) => setKey(event.target.value.toUpperCase())}
          placeholder="KEY"
          aria-label="variable name"
          autoComplete="off"
          spellCheck={false}
          invalid={!keyIsValid}
          data-testid="var-key"
          className="w-48"
        />
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="value"
          aria-label="variable value"
          autoComplete="off"
          spellCheck={false}
          data-testid="var-value"
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={!isValidEnvKey(key)} data-testid="var-add">
          add
        </Button>
      </form>

      {!keyIsValid ? (
        <p className="text-danger mt-2 font-mono text-xs" data-testid="var-key-error">
          <span aria-hidden="true">! </span>A shell will not source that name. Letters, digits and
          underscores, not starting with a digit.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-muted mt-8 font-mono text-sm" data-testid="vars-empty">
          <span aria-hidden="true">&gt; </span>
          no variables in this environment
        </p>
      ) : (
        <ul className="border-line mt-6 border-t" data-testid="var-list">
          {rows.map((row) => (
            <VariableRow key={row.id} row={row} revealed={revealAll} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Hand a file to the browser without involving a server.
 *
 * An object URL over a blob made in this tab. The alternative — a download
 * endpoint — would mean sending decrypted variables back to the one party this
 * whole product is built to keep them from.
 */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = name;
  anchor.click();

  URL.revokeObjectURL(url);
}

function VariableRow({ row, revealed }: { row: DecryptedEnvVar; revealed: boolean }) {
  const saveVar = useEnv((store) => store.saveVar);
  const deleteVar = useEnv((store) => store.deleteVar);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.value);
  const [shown, setShown] = useState(false);

  const visible = revealed || shown;

  return (
    <li
      className="border-line flex flex-wrap items-center gap-3 border-b py-3"
      data-testid="var-row"
    >
      <code className="text-accent secret shrink-0 font-mono text-xs" data-testid="var-row-key">
        {row.key}
      </code>

      {editing ? (
        <>
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`value for ${row.key}`}
            autoComplete="off"
            spellCheck={false}
            data-testid="var-row-edit"
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            onClick={() => {
              void saveVar(row.environmentId, { id: row.id, key: row.key, value: draft });
              setEditing(false);
            }}
            data-testid="var-row-save"
          >
            save
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(row.value);
              setEditing(false);
            }}
          >
            cancel
          </Button>
        </>
      ) : (
        <>
          <span
            className="text-fg secret min-w-0 flex-1 truncate font-mono text-xs"
            data-testid="var-row-value"
          >
            {visible ? row.value : maskValue(row.value)}
          </span>

          <Button
            type="button"
            variant="ghost"
            onClick={() => setShown((current) => !current)}
            aria-pressed={visible}
            data-testid="var-row-reveal"
          >
            {visible ? 'hide' : 'show'}
          </Button>
          <Button
            type="button"
            onClick={() => {
              void copySecret(row.value).then((ok) => {
                if (!ok) {
                  toast('The browser refused clipboard access.', { tone: 'danger' });
                  return;
                }
                pulse();
                // Never the value. See the note in toast-store.
                toast(`${row.key} copied. The clipboard clears in 30 seconds.`);
              });
            }}
            data-testid="var-row-copy"
          >
            copy
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(row.value);
              setEditing(true);
            }}
            data-testid="var-row-edit-open"
          >
            edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void deleteVar(row.id);
              toast(`${row.key} removed.`, { tone: 'warning' });
            }}
            data-testid="var-row-delete"
          >
            delete
          </Button>
        </>
      )}
    </li>
  );
}

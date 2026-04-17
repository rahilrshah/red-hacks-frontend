<script module lang="ts">
  type AttackTargetsCacheEntry = {
    gameName: string;
    roundInfo: any;
    challenges: any[];
    selectedChallengeId: string;
    statusError: string;
    timestampMs: number;
  };

  const ATTACK_TARGETS_CACHE_TTL_MS = 60_000;
  const attackTargetsCache = new Map<string, AttackTargetsCacheEntry>();

  type AttackMessage = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  };
</script>

<script lang="ts">
  import { PUBLIC_MAX_UPLOAD_MB } from '$env/static/public';
  import { page } from '$app/stores';
  import { calculateAttackBonus, SOFT_CHAR_CAP, SOFT_TURN_CAP } from '$lib/bonus';
  import GameSectionNav from '$lib/components/GameSectionNav.svelte';
  import { isGameActive, loadRoundChallengeIds, loadRoundRuntimeContext, resolveRoundType } from '$lib/gameplay';
  import { supabase } from '$lib/supabaseClient';
  import { onMount } from 'svelte';

  let gameId = $derived($page.params.gameId ?? '');
  let gameName = $state('');
  let roundInfo = $state<any>(null);
  let challenges = $state<any[]>([]);
  let selectedChallengeId = $state('');
  let loading = $state(false);
  let statusError = $state('');
  let attackMode = $derived(resolveRoundType(roundInfo));
  let loadingTargets = $state(false);
  let hasLoadedOnce = $state(false);

  // Chat state — per-target, swaps when selectedChallengeId changes
  let messages = $state<AttackMessage[]>([]);
  let promptInput = $state('');
  let secretKeyGuess = $state('');
  let selectedFiles = $state<File[]>([]);
  let attachmentError = $state('');
  let chatLoading = $state(false);
  let attackResult = $state<any>(null);
  let userId = $state('');

  const parsedMaxUploadMb = Number(PUBLIC_MAX_UPLOAD_MB || 10);
  const MAX_UPLOAD_MB = Number.isFinite(parsedMaxUploadMb) && parsedMaxUploadMb > 0 ? Math.trunc(parsedMaxUploadMb) : 10;
  const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

  let selectedTarget = $derived(challenges.find((c: any) => c.id === selectedChallengeId) ?? null);
  let selectedTargetCompromised = $derived(selectedTarget?.compromised_by_me === true);

  // Locked = user cannot take any attack action on the current target until
  // they click Attack Again (or the target is permanently compromised).
  // Triggered by: compromised target, judge verdict returned, escalation pending,
  // or a non-judge success flag still in attackResult.
  let attackLocked = $derived.by(() => {
    if (selectedTargetCompromised) return true;
    if (!attackResult) return false;
    if (typeof attackResult.verdict === 'string') return true;
    if (attackResult.escalated === true) return true;
    if (attackResult.success === true && attackResult.verdict === undefined) return true;
    return false;
  });

  // Attack Again is only meaningful when the user has a finished verdict
  // below 'full'. Full = permanent lockout (compromised). Pending escalation
  // waits on the admin — no button. Non-judge success also compromises.
  let canAttackAgain = $derived.by(() => {
    if (selectedTargetCompromised) return false;
    if (!attackResult) return false;
    if (attackResult.escalated === true) return false;
    if (attackResult.verdict === 'full') return false;
    if (typeof attackResult.verdict === 'string') return true;
    return false;
  });

  function attackAckKey(attackId: string): string {
    return `attack-ack:${attackId}`;
  }

  // Backed by localStorage for persistence across reloads, but mirrored into
  // a reactive $state Set so UI badges (target panel verdict pills) refresh
  // the instant the user clicks Attack Again. Hydrated on mount.
  let ackedAttackIds = $state(new Set<string>());

  function hydrateAckedFromStorage() {
    try {
      const ids = new Set<string>();
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('attack-ack:')) continue;
        if (localStorage.getItem(key) === '1') {
          ids.add(key.slice('attack-ack:'.length));
        }
      }
      ackedAttackIds = ids;
    } catch {}
  }

  function markAttackAcked(attackId: string | null | undefined) {
    if (!attackId) return;
    try { localStorage.setItem(attackAckKey(attackId), '1'); } catch {}
    const next = new Set(ackedAttackIds);
    next.add(attackId);
    ackedAttackIds = next;
  }

  function isAttackAcked(attackId: string | null | undefined): boolean {
    if (!attackId) return false;
    return ackedAttackIds.has(attackId);
  }
  let chatStorageKey = $derived(`attack-chat:${gameId}:${attackMode}:${selectedChallengeId}`);

  // Reward preview is fully server-driven. We never use the local messages
  // array for turn/char counting — that's what Clear Chat empties. The server
  // logs every attempt (including judge per-turn prompts) to the attacks table,
  // and `refreshServerTurnCount` below reads that count. The only client-side
  // input is the draft prompt the user is currently typing — that's the
  // "+1 turn" we're previewing.
  let potentialReward = $derived.by(() => {
    const draftChars = promptInput.length;
    const priorTurns = serverTurnCount ?? 0;
    const priorChars = serverCharCount ?? 0;

    return calculateAttackBonus({
      turnCount: priorTurns + 1,
      charCount: priorChars + draftChars,
      attackStealCoins: selectedTarget?.challenges?.attack_steal_coins ?? 0,
      defenseRewardCoins: selectedTarget?.challenges?.defense_reward_coins ?? 0
    });
  });

  function hasActiveSession(targetId: string): boolean {
    try {
      const key = `attack-chat:${gameId}:${attackMode}:${targetId}`;
      const stored = localStorage.getItem(key);
      if (!stored) return false;
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }

  // ---------- target list caching (from Denali's e3c2547) ----------

  function cacheKey() { return gameId; }

  function restoreFromCache() {
    const key = cacheKey();
    if (!key) return false;
    const cached = attackTargetsCache.get(key);
    if (!cached) return false;
    if (Date.now() - cached.timestampMs > ATTACK_TARGETS_CACHE_TTL_MS) {
      attackTargetsCache.delete(key);
      return false;
    }
    gameName = cached.gameName;
    roundInfo = cached.roundInfo;
    challenges = cached.challenges;
    selectedChallengeId = cached.selectedChallengeId;
    statusError = cached.statusError;
    return true;
  }

  function saveToCache() {
    const key = cacheKey();
    if (!key) return;
    attackTargetsCache.set(key, {
      gameName, roundInfo, challenges, selectedChallengeId, statusError,
      timestampMs: Date.now()
    });
  }

  $effect(() => {
    if (hasLoadedOnce && !loadingTargets) {
      saveToCache();
    }
  });

  // ---------- chat persistence ----------

  function loadChatForTarget() {
    if (!selectedChallengeId || !chatStorageKey) {
      messages = [];
      attackResult = null;
      return;
    }
    try {
      const raw = localStorage.getItem(chatStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) { messages = parsed; return; }
      }
    } catch { /* ignore */ }
    messages = [];
    attackResult = null;
  }

  function persistChat() {
    if (!chatStorageKey) return;
    localStorage.setItem(chatStorageKey, JSON.stringify(messages));
  }

  function formatFileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateFiles(files: File[]) {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      return `Attached files exceed the ${MAX_UPLOAD_MB} MB limit.`;
    }

    return '';
  }

  function handleFileSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    selectedFiles = Array.from(input.files ?? []);
    attachmentError = validateFiles(selectedFiles);
  }

  function clearAttachments() {
    selectedFiles = [];
    attachmentError = '';
  }

  function clearChatHistory() {
    if (!confirm('Are you sure you want to clear chat?\n\nThis resets the LLM conversation (the model forgets prior context) but does NOT reset your server-side bonus tracking. Your elegance score is based on ALL attempts you have sent, including cleared ones.')) {
      return;
    }
    messages = [];
    attackResult = null;
    if (chatStorageKey) localStorage.removeItem(chatStorageKey);
    // Refresh the server-side attempt count so the bonus preview stays
    // accurate instead of jumping back to 100%.
    void refreshServerTurnCount();
  }

  let serverTurnCount = $state<number | null>(null);
  let serverCharCount = $state<number | null>(null);

  async function refreshServerTurnCount() {
    if (!selectedChallengeId || !userId) {
      serverTurnCount = null;
      serverCharCount = null;
      return;
    }

    try {
      const targetColumn = attackMode === 'pve' ? 'challenge_id' : 'defended_challenge_id';
      const teamId = await getMyTeamId();
      if (!teamId) {
        serverTurnCount = 0;
        serverCharCount = 0;
        return;
      }

      // Mirror the server-side windowing from computeEleganceBonus:
      // turn count = failed attempts with created_at > max(last_success, updated_at).
      // Without this, a successful attack leaves phantom failed-turn history
      // from the pre-success window haunting the next attack's preview.

      // 1. Last successful attack against this target by this team
      const { data: lastSuccessRows } = await supabase
        .from('attacks')
        .select('created_at')
        .eq('attacker_team_id', teamId)
        .eq(targetColumn, selectedChallengeId)
        .eq('is_successful', true)
        .order('created_at', { ascending: false })
        .limit(1);
      const lastSuccessIso = lastSuccessRows?.[0]?.created_at ?? null;

      // 2. Defender's last prompt-update (PvP only — resets window when defender
      //    rewrites their system_prompt, same as server logic).
      let defenderUpdatedAtIso: string | null = null;
      if (attackMode !== 'pve') {
        const { data: defenderRow } = await supabase
          .from('defended_challenges')
          .select('updated_at')
          .eq('id', selectedChallengeId)
          .maybeSingle();
        defenderUpdatedAtIso = (defenderRow as any)?.updated_at ?? null;
      }

      const lastSuccessMs = lastSuccessIso ? new Date(lastSuccessIso).getTime() : 0;
      const defenderUpdatedMs = defenderUpdatedAtIso ? new Date(defenderUpdatedAtIso).getTime() : 0;
      const windowStartIso = new Date(Math.max(lastSuccessMs, defenderUpdatedMs)).toISOString();

      // 3. Count failed attempts after the window start
      const { data } = await supabase
        .from('attacks')
        .select('log, created_at')
        .eq('attacker_team_id', teamId)
        .eq(targetColumn, selectedChallengeId)
        .eq('is_successful', false)
        .gt('created_at', windowStartIso);

      serverTurnCount = data?.length ?? 0;
      serverCharCount = (data ?? []).reduce((acc, row: any) => {
        const prompt = row?.log?.latest_prompt;
        return acc + (typeof prompt === 'string' ? prompt.length : 0);
      }, 0);
    } catch {
      serverTurnCount = null;
      serverCharCount = null;
    }
  }

  async function getMyTeamId(): Promise<string> {
    const { data } = await supabase
      .from('team_members')
      .select('team_id, teams!inner(game_id)')
      .eq('user_id', userId)
      .eq('teams.game_id', gameId)
      .limit(1)
      .maybeSingle();
    return data?.team_id ?? '';
  }

  // When the selected target changes, swap the chat and fetch the server-side
  // turn count so the preview is accurate from the moment the user picks a target.
  $effect(() => {
    if (selectedChallengeId) {
      loadChatForTarget();
      attackResult = null;
      promptInput = '';
      secretKeyGuess = '';
      clearAttachments();
      serverTurnCount = null;
      serverCharCount = null;
      // Fire-and-forget: populates serverTurnCount in the background.
      void refreshServerTurnCount();
      // Pull any pending or resolved escalation for this (team, target) pair
      // so admin verdicts that landed between visits appear on page load.
      void loadEscalationForTarget();
    }
  });

  // ---------- attack invocation ----------

  function buildAttackPayload(args: { guess?: string } = {}) {
    const t = selectedTarget;
    const currentAttackMode = resolveRoundType(roundInfo);
    const resolvedSystemPrompt =
      (t?.system_prompt as string | undefined)?.trim() ||
      (t?.challenges?.default_prompt as string | undefined)?.trim() ||
      'You are a helpful assistant.';

    const payload: Record<string, unknown> = {
      prompt: messages.length > 0 ? messages[messages.length - 1].content : '',
      guess: args.guess || '',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      challenge: {
        challenge_id: t?.challenges?.id ?? selectedChallengeId,
        title: t?.challenges?.model_name ?? 'Challenge',
        description: t?.challenges?.description ?? '',
        objective:
          t?.challenges?.type === 'tool-calling'
            ? `Induce targeted tool use: ${t?.challenges?.target_tool_name ?? 'unknown tool'}`
            : 'Extract the secret key.',
        system_prompt: resolvedSystemPrompt,
        success_tool_name: t?.challenges?.target_tool_name ?? null
      }
    };

    if (currentAttackMode === 'pve') {
      payload.challenge_id = selectedChallengeId;
      payload.game_id = gameId;
      payload.round_type = 'pve';
    } else {
      payload.defended_challenge_id = selectedChallengeId;
    }

    return payload;
  }

  async function invokeAttack(args: { guess?: string } = {}) {
    if (!selectedTarget || !userId) {
      attackResult = { error: 'You must be signed in and have a valid target selected.' };
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) {
      attackResult = { error: 'Your session is missing or expired. Please sign in again.', success: false };
      return;
    }

    const selectedFilesError = validateFiles(selectedFiles);
    if (selectedFilesError) {
      attachmentError = selectedFilesError;
      attackResult = { success: false, error: selectedFilesError };
      return;
    }

    const payload = buildAttackPayload(args);
    let responseData: any = null;

    try {
      const formData = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        formData.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }

      for (const file of selectedFiles) {
        formData.append('attachments', file, file.name);
      }

      const response = await fetch(`/game/${gameId}/attack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData
      });
      const responseText = await response.text();
      try { responseData = responseText ? JSON.parse(responseText) : null; } catch { responseData = responseText; }
      if (!response.ok) {
        throw new Error(responseData?.error || responseData?.message || (typeof responseData === 'string' ? responseData : '') || `Attack request failed with status ${response.status}`);
      }
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while connecting to attack backend.' };
      return;
    }

    if (!responseData || typeof responseData !== 'object') {
      attackResult = { success: false, error: 'Attack backend returned an invalid response payload.' };
      return;
    }

    attackResult = responseData;

    if (responseData?.assistant) {
      messages = [...messages, { role: 'assistant', content: responseData.assistant, timestamp: new Date().toISOString() }];
      persistChat();
    }

    // Always refresh the server-side turn count after any attack invocation.
    // The /attack call inserted a row (success or failure) that shifts our
    // windowStart, so the preview must re-query to stay accurate. This is
    // the single source of truth — all callers (sendPrompt, submitSecretGuess,
    // endAttack, whatever) inherit it by going through invokeAttack.
    void refreshServerTurnCount();

    // If this attack fully compromised the target, mark it locally so the
    // target entry is flagged "compromised" and the action buttons disable.
    // Non-judge: success=true. Judge: verdict='full'.
    const compromised =
      responseData?.verdict === 'full' ||
      (responseData?.success === true && responseData?.verdict === undefined);
    if (compromised && selectedChallengeId) {
      challenges = challenges.map((c: any) =>
        c.id === selectedChallengeId ? { ...c, compromised_by_me: true } : c
      );
    }
  }

  async function sendPrompt() {
    if (!promptInput.trim()) return;
    chatLoading = true;
    try {
      messages = [...messages, { role: 'user', content: promptInput.trim(), timestamp: new Date().toISOString() }];
      persistChat();
      promptInput = '';
      await invokeAttack();
      // Refresh server-side count so the preview stays correct even if the
      // user clears chat later (server persists turns across local clears).
      void refreshServerTurnCount();
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while sending prompt.' };
    } finally {
      chatLoading = false;
    }
  }

  async function submitSecretGuess() {
    if (!secretKeyGuess.trim()) return;
    chatLoading = true;
    try {
      await invokeAttack({ guess: secretKeyGuess.trim() });
      secretKeyGuess = '';
      // Same rationale as sendPrompt: a successful guess writes an is_successful=true
      // row that shifts the windowStart, so we need to re-query.
      void refreshServerTurnCount();
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error while submitting secret key guess.' };
    } finally {
      chatLoading = false;
    }
  }

  /**
   * Judge-type challenges: commit the current transcript to the judge
   * LLM. Server returns a tier verdict (coefficient settles coins) or an
   * escalate (coins go into escrow pending admin review).
   */
  async function endAttack() {
    if (!selectedTarget || !userId) return;
    if (selectedTarget?.challenges?.type !== 'judge') return;

    const userTurnCount = messages.filter((m) => m.role === 'user').length;
    if (userTurnCount === 0) {
      attackResult = { success: false, error: 'Send at least one prompt before ending the attack.' };
      return;
    }

    if (!confirm('End this attack and submit to the judge?\n\nThe judge LLM will evaluate your full transcript against the challenge rubric and assign a tier (none / structural / partial / substantial / full). Coins will settle based on the verdict. If the judge cannot form a confident verdict, coins go into escrow for admin review.\n\nYou cannot undo this.')) {
      return;
    }

    chatLoading = true;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        attackResult = { success: false, error: 'Your session expired. Sign in again.' };
        return;
      }

      const payload = {
        ...buildAttackPayload(),
        end_attack: true
      };

      const response = await fetch(`/game/${gameId}/attack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload)
      });
      const text = await response.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (!response.ok && !data) {
        attackResult = { success: false, error: `End Attack failed: ${response.status}` };
        return;
      }

      attackResult = data;

      // After any judge verdict (or pending escalation) the buttons lock.
      // The user drives the state transition with the Attack Again button,
      // not auto-clear. Full verdicts flag the target permanently compromised.
      if (data?.verdict === 'full' && selectedChallengeId) {
        challenges = challenges.map((c: any) =>
          c.id === selectedChallengeId ? { ...c, compromised_by_me: true } : c
        );
      }
      // Refresh the server-side bonus window so Attack Again picks up the
      // advanced windowStart immediately when the user chooses to retry.
      void refreshServerTurnCount();
    } catch (err: any) {
      attackResult = { success: false, error: err?.message || 'Unexpected error ending attack.' };
    } finally {
      chatLoading = false;
    }
  }

  // Enter submits, Shift+Enter (or IME composition) inserts a newline.
  function handlePromptKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.isComposing) return;
    event.preventDefault();
    if (chatLoading) return;
    if (!promptInput.trim()) return;
    if (attachmentError) return;
    if (attackLocked) return;
    void sendPrompt();
  }

  // Attack Again: wipe chat + acknowledge the current verdict so we don't
  // re-surface it on the next target switch. Refresh server windowing so the
  // bonus preview drops back to turn 1.
  function attackAgain() {
    markAttackAcked(attackResult?.attack_id);
    messages = [];
    if (chatStorageKey) localStorage.removeItem(chatStorageKey);
    attackResult = null;
    void refreshServerTurnCount();
  }

  // Pull the most recent pending-or-resolved escalation for this target and
  // surface it so the attacker can see admin rulings that came in while they
  // were away. Non-escalation verdicts are intentionally skipped — the user
  // saw those live and clicked Attack Again, so showing them again is noise.
  function mapAttackRowToResult(row: any) {
    const log = (row.log && typeof row.log === 'object') ? row.log : {};
    if (row.escalation_status === 'pending') {
      return {
        attack_id: row.id,
        success: false,
        escalated: true,
        message: 'Attack submitted for admin review. Coins held in escrow pending decision.',
        escrow_amount: row.escrow_amount ?? log.escrow_amount ?? 0,
        max_potential_total: log.max_potential_total,
        judge_reason: row.judge_reason
      };
    }
    if (row.judge_verdict) {
      return {
        attack_id: row.id,
        success: (row.judge_coefficient ?? 0) > 0,
        verdict: row.judge_verdict,
        coefficient: row.judge_coefficient,
        judge_reason: row.judge_reason,
        stolen_coins: log.attacker_payout ?? log.stolen_coins,
        base_coins: log.base_coins,
        bonus_coins: log.bonus_coins,
        elegance_factor: log.elegance_factor,
        max_bonus: log.max_bonus,
        turn_count: log.turn_count,
        char_count: log.char_count,
        resolved_by_admin: row.escalation_status === 'resolved',
        admin_note: typeof log.admin_note === 'string' ? log.admin_note : null
      };
    }
    // Non-judge success (secret-key / tool-calling / keyword). Fill the same
    // fields the green "TARGET COMPROMISED!" banner consumes so it renders
    // identically on return visits, including the final payout breakdown and
    // the assistant's last reply.
    return {
      attack_id: row.id,
      success: row.is_successful === true,
      assistant: typeof log.assistant_message === 'string' ? log.assistant_message : null,
      message: 'Target compromised.',
      stolen_coins: log.stolen_coins,
      base_coins: log.base_coins,
      bonus_coins: log.bonus_coins,
      elegance_factor: log.elegance_factor,
      max_bonus: log.max_bonus,
      turn_count: log.turn_count,
      char_count: log.char_count,
      log: typeof log.backend_log === 'string' ? log.backend_log : null
    };
  }

  async function loadEscalationForTarget() {
    if (!selectedChallengeId || !userId) return;
    if (attackMode !== 'pvp') return;
    const teamId = await getMyTeamId();
    if (!teamId) return;

    // Pull the most recent "terminal" attack row for this (team, target):
    // judge_verdict set (any verdict, escalation, or admin-resolved) OR
    // non-judge success (is_successful=true with no verdict). The isAttackAcked
    // gate below filters out results the user already dismissed via Attack
    // Again, so normal non-judge compromises stay visible on return visits
    // but cleared-by-user ones don't resurface.
    const isJudge = selectedTarget?.challenges?.type === 'judge';
    let query = supabase
      .from('attacks')
      .select('id, judge_verdict, judge_coefficient, judge_reason, escalation_status, escrow_amount, is_successful, log, created_at')
      .eq('attacker_team_id', teamId)
      .eq('defended_challenge_id', selectedChallengeId);
    if (isJudge) {
      query = query.not('judge_verdict', 'is', null);
    } else {
      query = query.eq('is_successful', true).is('judge_verdict', null);
    }
    const { data } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return;
    if (isAttackAcked(data.id)) return;
    // Skip redundant updates: if the in-memory attackResult already points
    // at this row AND the server state hasn't advanced from pending to
    // resolved, nothing to do. The pending→resolved promotion is exactly
    // the transition we need to surface on admin rulings, so let it through.
    if (attackResult && attackResult.attack_id === data.id) {
      const pendingInCache = attackResult.escalated === true;
      const pendingOnServer = data.escalation_status === 'pending';
      if (!(pendingInCache && !pendingOnServer)) return;
    }

    attackResult = mapAttackRowToResult(data);
  }

  function formatTime(isoText: string) {
    try { return new Date(isoText).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  // ---------- target list loading ----------

  async function loadAttackTargets() {
    if (loadingTargets) return;
    loadingTargets = true;
    statusError = '';

    try {
      const { data: gameData, error: gameError } = await supabase
        .from('games')
        .select('name, is_active, start_time, end_time')
        .eq('id', gameId)
        .maybeSingle();

      if (gameError) { statusError = gameError.message; return; }
      gameName = gameData?.name ?? '';
      if (!gameData || !isGameActive(gameData)) { statusError = 'This game is not currently active.'; return; }

      const runtimeContext = await loadRoundRuntimeContext(supabase, gameId);
      roundInfo = runtimeContext.currentRound;

      if (runtimeContext.phase === 'intermission') { statusError = 'Round intermission is active. Attacks are paused until the next round starts.'; return; }
      if (runtimeContext.phase !== 'round-active' || !roundInfo) { statusError = 'There is no active round to attack right now.'; return; }

      const allowedChallengeIds = await loadRoundChallengeIds(supabase, gameId, roundInfo);
      if (allowedChallengeIds.length === 0) { challenges = []; return; }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) { statusError = userError.message; return; }
      userId = userData?.user?.id ?? '';

      let myTeamId: string | null = null;
      if (userId && resolveRoundType(roundInfo) === 'pvp') {
        const { data: membership, error: membershipError } = await supabase
          .from('team_members')
          .select('team_id, teams!inner(game_id)')
          .eq('user_id', userId)
          .eq('teams.game_id', gameId)
          .limit(1)
          .maybeSingle();
        if (membershipError) { statusError = membershipError.message; return; }
        myTeamId = membership?.team_id ?? null;

        const requiredDefenses = Math.max(0, Math.trunc(roundInfo?.required_defenses ?? 0));
        if (myTeamId && requiredDefenses > 0) {
          const { count: defendedCount, error: defendedCountError } = await supabase
            .from('defended_challenges')
            .select('id', { count: 'exact', head: true })
            .eq('team_id', myTeamId)
            .eq('is_active', true)
            .in('challenge_id', allowedChallengeIds);
          if (defendedCountError) { statusError = defendedCountError.message; return; }
          if ((defendedCount ?? 0) < requiredDefenses) {
            statusError = `Attack locked: defend at least ${requiredDefenses} prompt(s) this round before attacking (${defendedCount ?? 0}/${requiredDefenses} configured).`;
            return;
          }
        }
      }

      if (resolveRoundType(roundInfo) === 'pvp') {
        if (!myTeamId) { statusError = 'Could not determine your team for this game, so opponent targets cannot be resolved.'; return; }
        const { data, error } = await supabase
          .from('defended_challenges')
          .select('id, team_id, is_active, teams!inner(name, game_id, coins), challenges(*)')
          .eq('teams.game_id', gameId)
          .in('challenge_id', allowedChallengeIds)
          .gt('teams.coins', 0)
          .neq('team_id', myTeamId);
        if (error) { statusError = error.message; return; }

        // Flag targets this team has already compromised, and capture the
        // most-recent judge verdict per target so the panel can show the
        // outcome badge instead of stale "In Progress" state.
        const { data: myAttacks } = await supabase
          .from('attacks')
          .select('id, defended_challenge_id, judge_verdict, is_successful, escalation_status, created_at')
          .eq('attacker_team_id', myTeamId)
          .not('defended_challenge_id', 'is', null)
          .order('created_at', { ascending: false });

        const compromisedIds = new Set<string>();
        const latestVerdictByTarget = new Map<string, { attack_id: string; verdict: string; escalation_status: string | null }>();

        for (const row of myAttacks ?? []) {
          const targetId = row.defended_challenge_id as string;
          if (row.judge_verdict ? row.judge_verdict === 'full' : row.is_successful === true) {
            compromisedIds.add(targetId);
          }
          if (row.judge_verdict && !latestVerdictByTarget.has(targetId)) {
            latestVerdictByTarget.set(targetId, {
              attack_id: row.id,
              verdict: row.judge_verdict,
              escalation_status: row.escalation_status ?? null
            });
          }
        }

        challenges = (data ?? [])
          .map((row: any) => ({
            ...row,
            compromised_by_me: compromisedIds.has(row.id),
            latest_attempt: latestVerdictByTarget.get(row.id) ?? null
          }))
          .sort((a: any, b: any) => {
            if (a.compromised_by_me !== b.compromised_by_me) {
              return Number(a.compromised_by_me) - Number(b.compromised_by_me);
            }
            return Number(b.is_active) - Number(a.is_active);
          });
      } else {
        const { data, error } = await supabase
          .from('challenges')
          .select('id, name, description, type, model_name, attack_steal_coins, default_prompt, *')
          .in('id', allowedChallengeIds);
        if (error) { statusError = error.message; return; }
        challenges = (data ?? []).map((challenge: any) => ({
          id: challenge.id, team_id: null, is_active: true,
          teams: { name: roundInfo?.name ?? 'Default Defense', game_id: gameId, coins: 0 },
          challenges: challenge
        }));
      }

      if (challenges.length > 0 && !selectedChallengeId) {
        selectedChallengeId = challenges[0].id;
      }
    } catch (err: any) {
      statusError = err?.message || 'Unexpected error while loading attack targets.';
    } finally {
      hasLoadedOnce = true;
      saveToCache();
      loadingTargets = false;
    }
  }

  onMount(() => {
    hydrateAckedFromStorage();
    const restored = restoreFromCache();
    if (!restored) {
      void loadAttackTargets();
    } else {
      supabase.auth.getUser().then(({ data }) => { userId = data?.user?.id ?? ''; });
    }
  });

  // ---------- Realtime: refresh targets when defenses or teams change ----------

  $effect(() => {
    if (!gameId) return;

    const realtimeChannel = supabase
      .channel(`attack-targets:${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'defended_challenges' }, () => {
        void loadAttackTargets();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, () => {
        void loadAttackTargets();
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rounds', filter: `game_id=eq.${gameId}` },
        () => {
          void loadAttackTargets();
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'attacks' }, () => {
        // Catches admin escalation resolutions: when the admin rules on a
        // pending escalation, the attacks row gets its judge_verdict filled
        // in. Re-run the escalation loader so the attacker sees it live.
        void loadEscalationForTarget();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(realtimeChannel);
    };
  });
</script>

<div class="p-8 max-w-7xl mx-auto space-y-8">
  <div class="border-b border-white/10 pb-6">
    <div class="mb-4">
      <GameSectionNav gameId={gameId} current="attack" />
    </div>
    <h1 class="text-4xl font-black tracking-tight text-white mb-2 flex items-center gap-3">
      <span class="text-red-500">⚡</span> Red Team: Attack Interface
    </h1>
    {#if gameName}
      <p class="text-gray-400 text-sm">Game: <span class="font-semibold text-white">{gameName}</span></p>
    {/if}
    {#if roundInfo}
      <p class="text-gray-400 text-sm mb-2">Round: <span class="font-semibold text-white">{roundInfo.name}</span> · Type: <span class="font-semibold text-white uppercase">{roundInfo.type}</span></p>
    {/if}
  </div>

  {#if statusError}
    <div class="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md">{statusError}</div>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
    <!-- Left: target list -->
    <div class="col-span-1 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl overflow-hidden h-[48rem] flex flex-col shadow-xl">
      <div class="p-4 border-b border-white/10 bg-black/40 sticky top-0 z-10">
        <h2 class="text-xs font-bold text-gray-400 tracking-widest uppercase">Available Targets</h2>
      </div>
      <div class="divide-y divide-white/5 overflow-y-auto flex-1">
        {#each challenges as target}
          <button
            class="w-full text-left p-5 hover:bg-slate-800/80 transition-all block group {selectedChallengeId === target.id ? 'bg-red-500/10 border-l-4 border-red-500' : 'border-l-4 border-transparent'}"
            onclick={() => selectedChallengeId = target.id}
          >
            <div class="font-bold mb-1 group-hover:text-red-300 transition-colors flex items-center gap-2 {target.compromised_by_me ? 'text-gray-400' : 'text-white'}">
              {target.teams?.name || 'Default Defense'}
              {#if target.compromised_by_me}
                <span class="text-[10px] font-normal uppercase tracking-wider text-emerald-300 border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 rounded">Compromised</span>
              {:else if target.latest_attempt && !isAttackAcked(target.latest_attempt.attack_id)}
                {@const att = target.latest_attempt}
                {#if att.escalation_status === 'pending'}
                  <span class="text-[10px] font-normal uppercase tracking-wider text-amber-300 border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 rounded">Awaiting Review</span>
                {:else if att.verdict === 'none'}
                  <span class="text-[10px] font-normal uppercase tracking-wider text-red-300 border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 rounded">Verdict: None</span>
                {:else if att.verdict === 'structural'}
                  <span class="text-[10px] font-normal uppercase tracking-wider text-amber-300 border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 rounded">Verdict: Structural</span>
                {:else if att.verdict === 'partial'}
                  <span class="text-[10px] font-normal uppercase tracking-wider text-amber-300 border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 rounded">Verdict: Partial</span>
                {:else if att.verdict === 'substantial'}
                  <span class="text-[10px] font-normal uppercase tracking-wider text-emerald-300 border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 rounded">Verdict: Substantial</span>
                {/if}
              {:else if hasActiveSession(target.id)}
                <span class="text-[10px] font-normal uppercase tracking-wider text-amber-300 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded">In Progress</span>
              {/if}
            </div>
            <div class="text-xs text-gray-400 mb-3 truncate font-mono {target.compromised_by_me ? 'opacity-60' : ''}">{target.challenges?.name || target.challenges?.model_name} · {target.challenges?.type} · <span class="text-gray-500">{target.challenges?.model_name}</span></div>
            <div class="text-xs mb-2 {target.is_active ? 'text-emerald-300' : 'text-amber-300'} {target.compromised_by_me ? 'opacity-60' : ''}">{target.is_active ? 'Active Defense' : 'Inactive Defense'}</div>
            <div class="text-xs text-gray-300">{attackMode === 'pvp' ? `Team Coins: ${target.teams?.coins ?? 0}` : 'Default prompt target'}</div>
            <div class="text-xs text-gray-500 mt-1">Base steal value: {target.challenges?.attack_steal_coins ?? 0}</div>
          </button>
        {/each}
        {#if challenges.length === 0}
          <div class="p-5 text-sm text-gray-500">
            {attackMode === 'pvp' ? 'No opponent defended challenges were found for this game yet.' : 'No round challenges are available for this game yet.'}
          </div>
        {/if}
      </div>
    </div>

    <!-- Right: inline chat -->
    <div class="col-span-1 md:col-span-3 border border-white/10 bg-slate-900/50 backdrop-blur-md rounded-xl shadow-xl flex flex-col h-[48rem] overflow-hidden">
      {#if !selectedTarget}
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center text-gray-500 space-y-3">
            <div class="text-5xl">🎯</div>
            <p class="font-semibold text-lg">No target selected</p>
            <p class="text-sm">Select an opponent from the list to begin the assault.</p>
          </div>
        </div>
      {:else}
        <!-- Target header -->
        <div class="p-4 border-b border-white/10 bg-black/40 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-white font-bold">
              {selectedTarget.teams?.name || 'Default Defense'}
              <span class="text-gray-400 font-normal ml-2">{selectedTarget.challenges?.name || selectedTarget.challenges?.model_name} · {selectedTarget.challenges?.type} · <span class="text-gray-500 font-mono">{selectedTarget.challenges?.model_name}</span></span>
            </p>
            <p class="text-xs text-gray-500 mt-1">{selectedTarget.challenges?.description}</p>
          </div>
          <button
            onclick={clearChatHistory}
            disabled={attackLocked}
            class="px-2.5 py-1 rounded border border-white/20 hover:border-white/40 text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-white/20"
            title={attackLocked ? 'Attack finalized. Use Attack Again to start a new attempt.' : 'Resets the LLM conversation only. Server still counts prior attempts for bonus.'}
          >
            Clear Chat
          </button>
        </div>

        {#if selectedTargetCompromised}
          <div class="px-4 py-3 border-b border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-sm flex items-center gap-2">
            <span class="font-bold uppercase tracking-wider text-xs">✓ Compromised</span>
            <span class="text-emerald-300/80">Your team has already breached this defense. Further attacks are disabled.</span>
          </div>
        {/if}

        <!-- Messages -->
        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          {#if messages.length === 0}
            <p class="text-gray-500 text-sm">No messages yet. Send your first attack prompt below.</p>
          {:else}
            {#each messages as message}
              <div class="rounded-lg p-3 {message.role === 'user' ? 'bg-red-500/10 border border-red-500/20' : 'bg-white/5 border border-white/10'}">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs uppercase tracking-wider {message.role === 'user' ? 'text-red-300' : 'text-gray-300'}">{message.role}</span>
                  <span class="text-xs text-gray-500">{formatTime(message.timestamp)}</span>
                </div>
                <p class="text-sm text-gray-100 whitespace-pre-wrap">{message.content}</p>
              </div>
            {/each}
          {/if}

          {#if attackResult}
            {@const isSuccess = !!attackResult.success}
            {@const isError = !!attackResult.error}
            {@const isEscalated = attackResult.escalated === true}
            {@const judgeVerdict = attackResult.verdict as string | undefined}
            {#if isEscalated}
              <div class="p-4 rounded-xl border bg-amber-500/10 border-amber-500/50 text-amber-300">
                <div class="font-black text-lg mb-2">⏳ PENDING REVIEW</div>
                <div class="text-sm opacity-90 font-medium">{attackResult.message || 'Attack submitted to admin for review.'}</div>
                {#if typeof attackResult.escrow_amount === 'number'}
                  <div class="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono">
                    <span class="font-semibold">{attackResult.escrow_amount} coins</span> held in escrow. Max potential payout: {attackResult.max_potential_total ?? '?'}.
                  </div>
                {/if}
              </div>
            {:else if judgeVerdict}
              {@const isRealTier = judgeVerdict !== 'escalate'}
              {@const verdictColor = judgeVerdict === 'full' || judgeVerdict === 'substantial' ? 'green' : judgeVerdict === 'partial' ? 'amber' : judgeVerdict === 'structural' ? 'amber' : 'red'}
              <div class="p-4 rounded-xl border bg-{verdictColor}-500/10 border-{verdictColor}-500/50 text-{verdictColor}-400">
                <div class="font-black text-lg mb-2">⚖️ JUDGE VERDICT: {judgeVerdict.toUpperCase()} (×{attackResult.coefficient ?? 0})</div>
                {#if attackResult.resolved_by_admin}
                  <div class="inline-block text-[10px] uppercase tracking-widest font-bold mb-2 px-2 py-0.5 rounded border border-white/20 bg-white/5 text-white">Admin Resolved</div>
                {/if}
                {#if attackResult.judge_reason}
                  <div class="text-sm opacity-90 font-medium whitespace-pre-wrap">{attackResult.judge_reason}</div>
                {/if}
                {#if isRealTier && typeof attackResult.stolen_coins === 'number'}
                  <div class="mt-3 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-xs font-mono text-gray-200">
                    {#if attackResult.bonus_coins > 0}
                      <span class="font-semibold">{attackResult.stolen_coins} coins</span> = {attackResult.base_coins ?? 0} base + {attackResult.bonus_coins} bonus
                    {:else}
                      <span class="font-semibold">{attackResult.stolen_coins} coins</span> base only
                    {/if}
                    {#if typeof attackResult.elegance_factor === 'number'}· elegance {Math.round(attackResult.elegance_factor * 100)}%{/if}
                    {#if typeof attackResult.turn_count === 'number'}· {attackResult.turn_count} {attackResult.turn_count === 1 ? 'turn' : 'turns'}{/if}
                  </div>
                {/if}
                {#if canAttackAgain}
                  <div class="mt-4">
                    <button
                      type="button"
                      onclick={attackAgain}
                      class="px-4 py-2 rounded-lg border border-white/30 bg-white/10 hover:bg-white/20 text-white font-bold uppercase text-sm tracking-wider transition-colors"
                    >
                      ↻ Attack Again
                    </button>
                    <span class="ml-3 text-xs text-gray-400">Clears the chat and resets your bonus clock. Judge verdict stands.</span>
                  </div>
                {/if}
              </div>
            {:else}
              <div class="p-4 rounded-xl border {isSuccess ? 'bg-green-500/10 border-green-500/50 text-green-400' : isError ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-amber-500/10 border-amber-500/50 text-amber-300'}">
                <div class="font-black text-lg mb-2">{isSuccess ? '✅ TARGET COMPROMISED!' : isError ? '⚠️ ATTACK ERROR' : '↻ ATTEMPT COMPLETE - KEEP PUSHING'}</div>
                <div class="text-sm opacity-90 font-medium">{attackResult.message || attackResult.error || 'No compromise yet. Refine your prompt and try again.'}</div>
                {#if isSuccess && typeof attackResult.bonus_coins === 'number' && attackResult.bonus_coins > 0}
                  <div class="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono">
                    <div class="font-semibold">⚡ Elegance bonus: +{attackResult.bonus_coins} coins</div>
                    <div class="opacity-80 mt-1">
                      {attackResult.base_coins ?? 0} base + {attackResult.bonus_coins} bonus = {attackResult.stolen_coins ?? 0} total
                      {#if typeof attackResult.elegance_factor === 'number'}· elegance {Math.round(attackResult.elegance_factor * 100)}%{/if}
                      {#if typeof attackResult.turn_count === 'number'}· {attackResult.turn_count} {attackResult.turn_count === 1 ? 'turn' : 'turns'}{/if}
                    </div>
                  </div>
                {:else if isSuccess && typeof attackResult.base_coins === 'number'}
                  <div class="mt-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-300 text-xs font-mono">
                    Base reward: {attackResult.base_coins} coins (elegance exhausted, no bonus)
                  </div>
                {/if}
                {#if attackResult.log}
                  <div class="mt-3 text-xs bg-black/60 p-3 rounded-lg text-gray-300 font-mono max-h-44 overflow-y-auto border border-white/5">{attackResult.log}</div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>

        <!-- Input area -->
        <div class="p-4 border-t border-white/10 bg-black/20 space-y-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Attack Prompt</p>
            {#if serverTurnCount === null}
              <!-- Server hasn't reported the count yet. Show a placeholder
                   instead of a number so we never display an inflated reward. -->
              <div class="px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs font-mono text-gray-500">
                loading reward…
              </div>
            {:else if selectedTarget?.challenges?.type === 'judge'}
              <!-- Judge challenges: coefficient is picked by the judge, so the
                   preview above doesn't reflect the actual payout — only the
                   max (full verdict). Show that max honestly and surface the
                   per-tier breakdown below. -->
              <div class="px-3 py-1.5 rounded-lg bg-amber-900/30 border border-amber-500/30 text-xs font-mono text-amber-200">
                {#if potentialReward.base === 0}
                  Reward: <strong>0</strong> (no steal configured)
                {:else}
                  Max reward: <strong class="text-amber-100">{potentialReward.total}</strong>
                  <span class="text-amber-400/70">· judge picks tier · turn {(serverTurnCount ?? 0) + 1}</span>
                {/if}
              </div>
            {:else}
              <div class="px-3 py-1.5 rounded-lg bg-amber-900/30 border border-amber-500/30 text-xs font-mono text-amber-200">
                {#if potentialReward.base === 0}
                  Reward: <strong>0</strong> (no steal configured)
                {:else if potentialReward.bonus > 0}
                  Reward: <strong class="text-amber-100">{potentialReward.total}</strong>
                  = {potentialReward.base} + <strong class="text-green-300">{potentialReward.bonus}</strong> bonus
                  <span class="text-amber-400/70">· {Math.round(potentialReward.eleganceFactor * 100)}% · turn {(serverTurnCount ?? 0) + 1}</span>
                {:else}
                  Reward: <strong>{potentialReward.base}</strong> base only
                {/if}
              </div>
            {/if}
          </div>
          {#if selectedTarget?.challenges?.type === 'judge' && potentialReward.base > 0}
            {@const stealCoins = selectedTarget?.challenges?.attack_steal_coins ?? 0}
            {@const defenseReward = selectedTarget?.challenges?.defense_reward_coins ?? 0}
            {@const elegance = potentialReward.eleganceFactor}
            {@const tiersBreakdown = [
              { name: 'none', coef: 0 },
              { name: 'structural', coef: 0.25 },
              { name: 'partial', coef: 0.5 },
              { name: 'substantial', coef: 0.75 },
              { name: 'full', coef: 1 }
            ].map((t) => {
              const scaledBase = Math.floor(stealCoins * t.coef);
              const scaledMaxBonus = Math.min(defenseReward, 3 * scaledBase);
              const scaledBonus = Math.floor(scaledMaxBonus * elegance);
              return { ...t, total: scaledBase + scaledBonus };
            })}
            <div class="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[11px] font-mono text-gray-400 flex gap-3 flex-wrap">
              <span class="text-gray-500">tier payouts at current elegance ({Math.round(elegance * 100)}%):</span>
              {#each tiersBreakdown as t}
                <span><span class="text-gray-500">{t.name}:</span> <span class="text-gray-200">{t.total}</span></span>
              {/each}
            </div>
          {/if}
          <textarea bind:value={promptInput} onkeydown={handlePromptKeydown} class="w-full bg-black/60 border border-white/10 rounded-xl p-4 text-white h-28 focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none transition-all placeholder:text-gray-600 font-mono text-sm resize-y" placeholder="> Type your attack prompt... (Enter to send · Shift+Enter for newline)"></textarea>
          <!-- Compact row: file attach button + file chips + send prompt -->
          <div class="flex items-center gap-2 flex-wrap">
            <label class="shrink-0 cursor-pointer px-3 py-2 rounded-lg border border-white/15 bg-white/5 text-xs text-gray-200 hover:bg-white/10 transition-colors font-medium" title="Attach text files (max {MAX_UPLOAD_MB} MB total)">
              📎 Attach{selectedFiles.length > 0 ? ` (${selectedFiles.length})` : ''}
              <input
                type="file"
                multiple
                accept=".txt,.md,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json"
                onchange={handleFileSelection}
                class="hidden"
              />
            </label>
            {#if selectedFiles.length > 0}
              <button type="button" onclick={clearAttachments} class="shrink-0 text-[11px] text-gray-400 hover:text-white transition-colors underline">clear</button>
              <div class="flex flex-wrap gap-1 text-[10px] text-gray-400 flex-1 min-w-0">
                {#each selectedFiles as file}
                  <span class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono truncate">{file.name} · {formatFileSize(file.size)}</span>
                {/each}
              </div>
            {:else}
              <span class="text-[11px] text-gray-500 flex-1">Text only · {MAX_UPLOAD_MB} MB max</span>
            {/if}
            <button onclick={sendPrompt} disabled={chatLoading || !promptInput.trim() || !!attachmentError || attackLocked} class="shrink-0 bg-red-600 hover:bg-red-500 text-white px-6 py-2.5 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all uppercase text-sm">
              {chatLoading ? 'SENDING...' : 'Send Prompt'}
            </button>
            {#if selectedTarget?.challenges?.type === 'judge'}
              <button onclick={endAttack} disabled={chatLoading || messages.filter((m) => m.role === 'user').length === 0 || attackLocked} class="shrink-0 border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 px-4 py-2.5 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all uppercase text-sm" title="Commit this transcript to the judge. Coins settle on verdict or go to escrow.">
                {chatLoading ? 'JUDGING...' : '⚖️ End Attack'}
              </button>
            {/if}
          </div>
          {#if attachmentError}
            <p class="text-xs text-red-300">{attachmentError}</p>
          {/if}

          {#if selectedTarget?.challenges?.type === 'secret-key'}
            <div class="flex gap-3 pt-2 border-t border-white/10">
              <input bind:value={secretKeyGuess} disabled={attackLocked} class="flex-1 bg-black/60 border border-white/10 rounded-xl p-3 text-white focus:ring-2 focus:ring-red-500/50 focus:border-red-500 outline-none placeholder:text-gray-600 font-mono text-sm disabled:opacity-50" placeholder="Secret key guess..." />
              <button onclick={submitSecretGuess} disabled={chatLoading || !secretKeyGuess.trim() || attackLocked} class="border border-red-500/40 hover:bg-red-500/10 text-red-400 px-4 py-3 rounded-xl font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all uppercase text-sm">
                {chatLoading ? '...' : 'Guess'}
              </button>
            </div>
          {/if}

          {#if selectedTarget?.challenges?.type === 'judge'}
            <p class="text-[11px] text-gray-500">
              Judge challenge: no per-turn coin transfer — click <span class="text-amber-400">End Attack</span> when ready to commit the transcript to the judge.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

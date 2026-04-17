// Admin-only dry-run proxy for the interp-backend
// `POST /v1/steering-vectors:dry-run` endpoint. Mirrors the
// `admin/challenges/validate-model/+server.ts` convention: thin forwarder
// that returns `{ok, details}` so the existing admin result-card component
// can render the response unchanged.
//
// This does NOT write to Supabase. Users who want to persist a vector go
// through the sibling `/api/steering-vectors` route (POST). This route is
// intentionally admin-gated because the dry-run is GPU-expensive and we
// don't want it open to arbitrary authed players.

import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { createClient } from '@supabase/supabase-js';
import { buildBackendRequest, extractBearerToken } from '$lib/steering/server';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const accessToken = extractBearerToken(request.headers.get('authorization'));
		if (!accessToken) {
			return json({ ok: false, error: 'Unauthorized' }, { status: 401 });
		}

		const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
		if (!PUBLIC_SUPABASE_URL || !serviceRoleKey) {
			return json({ ok: false, error: 'Server misconfigured' }, { status: 500 });
		}

		const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, serviceRoleKey, {
			auth: { persistSession: false, autoRefreshToken: false }
		});

		const { data: authData } = await supabaseAdmin.auth.getUser(accessToken);
		const userId = authData.user?.id;
		if (!userId) {
			return json({ ok: false, error: 'Unauthorized' }, { status: 401 });
		}

		const { data: profile } = await supabaseAdmin
			.from('profiles')
			.select('role')
			.eq('id', userId)
			.maybeSingle();
		if (profile?.role !== 'admin') {
			return json({ ok: false, error: 'Admin role required' }, { status: 403 });
		}

		const backendUrl = env.INTERP_BACKEND_URL?.trim();
		const internalSecret = env.INTERP_INTERNAL_SECRET?.trim();
		if (!backendUrl || !internalSecret) {
			return json(
				{ ok: false, error: 'INTERP_BACKEND_URL or INTERP_INTERNAL_SECRET missing on the server.' },
				{ status: 500 }
			);
		}

		const rawBody = await request.json().catch(() => null);
		if (!rawBody || typeof rawBody !== 'object') {
			return json({ ok: false, error: 'Request body must be JSON.' }, { status: 400 });
		}

		const backendRequest = buildBackendRequest({
			backendUrl,
			internalSecret,
			path: '/v1/steering-vectors:dry-run',
			userId,
			body: rawBody as Record<string, unknown>
		});

		const backendResp = await fetch(backendRequest.url, backendRequest.init);

		const bodyText = await backendResp.text();
		let parsed: any;
		try {
			parsed = bodyText ? JSON.parse(bodyText) : null;
		} catch {
			parsed = { ok: false, error: bodyText.slice(0, 300) };
		}

		if (!backendResp.ok) {
			const errorMessage = parsed?.detail || parsed?.error || bodyText?.slice(0, 300) || 'Backend error';
			return json(
				{ ok: false, error: errorMessage, status: backendResp.status },
				{ status: 200 }
			);
		}

		// The backend already returns `{ok, details}` on success.
		return json(parsed ?? { ok: true });
	} catch (err: any) {
		return json(
			{ ok: false, error: err?.message || 'Validation request failed.' },
			{ status: 500 }
		);
	}
};

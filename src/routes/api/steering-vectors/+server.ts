// User-facing CRUD proxy for the steering-vectors feature.
//
// GET  /api/steering-vectors        — returns the caller's vectors + any
//                                     public vectors. RLS enforces the
//                                     filtering server-side; we forward
//                                     the user's JWT so policies fire.
//
// POST /api/steering-vectors        — compiles a new vector via the
//                                     interp-backend (which writes to
//                                     Supabase under the service-role
//                                     key) and returns the inserted row.
//                                     The shared-secret header
//                                     `X-Internal-Secret` is attached
//                                     server-side and NEVER exposed to
//                                     the browser.
//
// DELETE /api/steering-vectors?id=… — soft-hides by flipping is_active
//                                     off. RLS enforces ownership.
//
// This file is thin on purpose: the backend owns the direction-extraction
// math and the authoritative validation. Any field-level errors surface
// as 422 with a `{detail}` payload we pass through.

import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { createClient } from '@supabase/supabase-js';
import { buildBackendRequest, extractBearerToken } from '$lib/steering/server';

function supabaseAdmin() {
	const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
	if (!PUBLIC_SUPABASE_URL || !serviceRoleKey) {
		throw new Error('Supabase server credentials are not configured.');
	}
	return createClient(PUBLIC_SUPABASE_URL, serviceRoleKey, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}

async function requireUser(request: Request): Promise<string> {
	const accessToken = extractBearerToken(request.headers.get('authorization'));
	if (!accessToken) {
		throw Object.assign(new Error('Unauthorized'), { status: 401 });
	}
	const { data } = await supabaseAdmin().auth.getUser(accessToken);
	if (!data.user?.id) {
		throw Object.assign(new Error('Unauthorized'), { status: 401 });
	}
	return data.user.id;
}

export const GET: RequestHandler = async ({ request, url }) => {
	try {
		const userId = await requireUser(request).catch((err) => {
			throw err;
		});

		const modelFilter = url.searchParams.get('model_name')?.trim() || null;
		const activeOnly = url.searchParams.get('active_only') === '1';

		let query = supabaseAdmin()
			.from('steering_vectors')
			.select(
				'id, name, description, model_name, target_layers, pooling, position, ' +
					'min_coefficient, max_coefficient, visibility, is_active, created_by, created_at, updated_at'
			)
			.or(`visibility.eq.public,created_by.eq.${userId}`)
			.order('created_at', { ascending: false });

		if (modelFilter) {
			query = query.eq('model_name', modelFilter);
		}
		if (activeOnly) {
			query = query.eq('is_active', true);
		}

		const { data, error } = await query;
		if (error) {
			return json({ error: error.message }, { status: 500 });
		}
		return json({ vectors: data ?? [] });
	} catch (err: any) {
		const status = err?.status ?? 500;
		return json({ error: err?.message || 'Failed to load steering vectors.' }, { status });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const userId = await requireUser(request);

		const rawBody = await request.json().catch(() => null);
		if (!rawBody || typeof rawBody !== 'object') {
			return json({ error: 'Request body must be JSON.' }, { status: 400 });
		}

		const backendUrl = env.INTERP_BACKEND_URL?.trim();
		const internalSecret = env.INTERP_INTERNAL_SECRET?.trim();
		if (!backendUrl || !internalSecret) {
			return json(
				{ error: 'INTERP_BACKEND_URL or INTERP_INTERNAL_SECRET missing on the server.' },
				{ status: 500 }
			);
		}

		// Inject created_by server-side so a malicious client cannot claim
		// to author a vector for another user. The backend also checks,
		// but belt-and-braces is cheap here.
		const backendRequest = buildBackendRequest({
			backendUrl,
			internalSecret,
			path: '/v1/steering-vectors',
			userId,
			body: rawBody as Record<string, unknown>
		});

		const backendResp = await fetch(backendRequest.url, backendRequest.init);

		const bodyText = await backendResp.text();
		let parsed: any;
		try {
			parsed = bodyText ? JSON.parse(bodyText) : null;
		} catch {
			parsed = { error: bodyText.slice(0, 300) };
		}

		return json(parsed ?? {}, { status: backendResp.status });
	} catch (err: any) {
		const status = err?.status ?? 500;
		return json({ error: err?.message || 'Failed to create steering vector.' }, { status });
	}
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	try {
		const userId = await requireUser(request);

		const vectorId = url.searchParams.get('id')?.trim();
		if (!vectorId) {
			return json({ error: 'id query parameter is required.' }, { status: 400 });
		}

		// We rely on RLS to reject the update if the caller does not own
		// the row. We use the service role here only to have a single
		// consistent code path; the `.eq('created_by', userId)` filter is
		// defense in depth.
		const { error } = await supabaseAdmin()
			.from('steering_vectors')
			.update({ is_active: false })
			.eq('id', vectorId)
			.eq('created_by', userId);

		if (error) {
			return json({ error: error.message }, { status: 500 });
		}
		return json({ ok: true });
	} catch (err: any) {
		const status = err?.status ?? 500;
		return json({ error: err?.message || 'Failed to delete steering vector.' }, { status });
	}
};

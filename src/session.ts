import { json, redirect } from '@remix-run/cloudflare';
import type { AppLoadContext, LoaderFunctionArgs, SessionData, TypedResponse } from '@remix-run/cloudflare';
import type { AccessToken, AuthorizedData, UnauthorizedData, AuthKitLoaderOptions, Session } from './interfaces.js';
import { getAuthorizationUrl } from './get-authorization-url.js';
import { getWorkos } from './workos.js';

import { sealData, unsealData } from 'iron-session';
import { jwtVerify, createRemoteJWKSet, decodeJwt } from 'jose';
import { getCookieFunctions } from './cookie.js';

const getJWKs = (context: AppLoadContext) => {

  if (!context.cloudflare.env) {
    throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_MAX_AGE, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI must be set in the environment variables');
  }

  const workos = getWorkos(context);
  return createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl((context.cloudflare.env as Record<string, string>).WORKOS_CLIENT_ID)));
}

async function updateSession(request: Request, debug: boolean, context: AppLoadContext) {
  const session = await getSessionFromCookie(request.headers.get('Cookie') as string, context);

  // If no session, just continue
  if (!session) {
    return null;
  }

  const hasValidSession = await verifyAccessToken(session.accessToken, context);

  if (hasValidSession) {
    if (debug) console.log('Session is valid');
    return session;
  }

  const { getSession, commitSession, destroySession } = getCookieFunctions(context);
  const workos = getWorkos(context);

  try {
    if (debug) console.log('Session invalid. Attempting refresh', session.refreshToken);

    if (!context.cloudflare.env) {
      throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_MAX_AGE, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI must be set in the environment variables');
    }

    // If the session is invalid (i.e. the access token has expired) attempt to re-authenticate with the refresh token
    const { accessToken, refreshToken } = await workos.userManagement.authenticateWithRefreshToken({
      clientId: (context.cloudflare.env as Record<string, string>).WORKOS_CLIENT_ID,
      refreshToken: session.refreshToken,
    });

    if (debug) console.log('Refresh successful:', refreshToken);

    const newSession = {
      accessToken,
      refreshToken,
      user: session.user,
      impersonator: session.impersonator,
      headers: {},
    };

    // Encrypt session with new access and refresh tokens
    const updatedSession = await getSession(request.headers.get('Cookie'));
    updatedSession.set('jwt', await encryptSession(newSession, context));

    newSession.headers = {
      'Set-Cookie': await commitSession(updatedSession),
    };

    return newSession;
  } catch (e) {
    if (debug) console.log('Failed to refresh. Deleting cookie and redirecting.', e);

    const cookieSession = await getSession(request.headers.get('Cookie'));

    throw redirect('/', {
      headers: {
        'Set-Cookie': await destroySession(cookieSession),
      },
    });
  }
}

async function encryptSession(session: Session, context: AppLoadContext) {
  if (!context.cloudflare.env) {
    throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_MAX_AGE, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI must be set in the environment variables');
  }
  return sealData(session, { password:( context.cloudflare.env as Record<string, string>).WORKOS_COOKIE_PASSWORD });
}

type LoaderValue<Data> = Response | TypedResponse<Data> | NonNullable<Data> | null;
type LoaderReturnValue<Data> = Promise<LoaderValue<Data>> | LoaderValue<Data>;

type AuthLoader<Data> = (
  args: LoaderFunctionArgs & { auth: AuthorizedData | UnauthorizedData },
) => LoaderReturnValue<Data>;

type AuthorizedAuthLoader<Data> = (args: LoaderFunctionArgs & { auth: AuthorizedData }) => LoaderReturnValue<Data>;

async function authkitLoader(
  loaderArgs: LoaderFunctionArgs,
  options: AuthKitLoaderOptions & { ensureSignedIn: true },
): Promise<TypedResponse<AuthorizedData>>;

async function authkitLoader(
  loaderArgs: LoaderFunctionArgs,
  options?: AuthKitLoaderOptions,
): Promise<TypedResponse<AuthorizedData | UnauthorizedData>>;

async function authkitLoader<Data = unknown>(
  loaderArgs: LoaderFunctionArgs,
  loader: AuthorizedAuthLoader<Data>,
  options: AuthKitLoaderOptions & { ensureSignedIn: true },
): Promise<TypedResponse<Data & AuthorizedData>>;

async function authkitLoader<Data = unknown>(
  loaderArgs: LoaderFunctionArgs,
  loader: AuthLoader<Data>,
  options?: AuthKitLoaderOptions,
): Promise<TypedResponse<Data & (AuthorizedData | UnauthorizedData)>>;

async function authkitLoader<Data = unknown>(
  loaderArgs: LoaderFunctionArgs,
  loaderOrOptions?: AuthLoader<Data> | AuthorizedAuthLoader<Data> | AuthKitLoaderOptions,
  options: AuthKitLoaderOptions = {},
) {
  const loader = typeof loaderOrOptions === 'function' ? loaderOrOptions : undefined;
  const { ensureSignedIn = false, debug = false } = typeof loaderOrOptions === 'object' ? loaderOrOptions : options;

  const { request, context } = loaderArgs;
  const session = await updateSession(request, debug, context);

  const { getSession, destroySession } = getCookieFunctions(loaderArgs.context);

  if (!session) {
    if (ensureSignedIn) {
      const returnPathname = getReturnPathname(request.url);
      const cookieSession = await getSession(request.headers.get('Cookie'));

      throw redirect(await getAuthorizationUrl({ returnPathname }, loaderArgs.context), {
        headers: {
          'Set-Cookie': await destroySession(cookieSession),
        },
      });
    }

    const auth: UnauthorizedData = {
      user: null,
      accessToken: null,
      impersonator: null,
      organizationId: null,
      permissions: null,
      role: null,
      sessionId: null,
      sealedSession: null,
    };

    return await handleAuthLoader(loader, loaderArgs, auth);
  }

  const {
    sessionId,
    organizationId = null,
    role = null,
    permissions = [],
  } = getClaimsFromAccessToken(session.accessToken);

  const cookieSession = await getSession(request.headers.get('Cookie'));

  const auth: AuthorizedData = {
    user: session.user,
    sessionId,
    accessToken: session.accessToken,
    organizationId,
    role,
    permissions,
    impersonator: session.impersonator ?? null,
    sealedSession: cookieSession.get('jwt'),
  };

  return await handleAuthLoader(loader, loaderArgs, auth, session);
}

async function handleAuthLoader(
  loader: AuthLoader<unknown> | AuthorizedAuthLoader<unknown> | undefined,
  args: LoaderFunctionArgs,
  auth: AuthorizedData | UnauthorizedData,
  session?: Session,
) {
  if (!loader) {
    return json(auth, session ? { headers: { ...session.headers } } : undefined);
  }

  // If there's a custom loader, get the resulting data and return it with our
  // auth data plus session cookie header
  const loaderResult = await loader({ ...args, auth: auth as AuthorizedData });

  if (loaderResult instanceof Response) {
    // If the result is a redirect, return it unedited
    if (loaderResult.status >= 300 && loaderResult.status < 400) {
      return loaderResult;
    }

    const newResponse = new Response(loaderResult.body, loaderResult);
    const data = await newResponse.json();

    // Set the content type in case the user returned a Response instead of the
    // json helper method
    newResponse.headers.set('Content-Type', 'application/json; charset=utf-8');
    if (session) {
      newResponse.headers.append('Set-Cookie', session.headers['Set-Cookie']);
    }

    // @ts-expect-error - TODO: Fix this
    return json({ ...data, ...auth }, newResponse);
  }

  // If the loader returns a non-Response, assume it's a data object
  return json({ ...loaderResult, ...auth }, session ? { headers: { ...session.headers } } : undefined);
}

async function terminateSession(request: Request, context: AppLoadContext) {

  const { getSession, destroySession } = getCookieFunctions(context);
  const workos = getWorkos(context);

  const encryptedSession = await getSession(request.headers.get('Cookie'));
  const { accessToken } = (await getSessionFromCookie(
    request.headers.get('Cookie') as string,
    context,
    encryptedSession,
  ) ?? { accessToken: null }) as Session;

  if (!accessToken) {
    return redirect('/', {
      headers: {
        'Set-Cookie': await destroySession(encryptedSession),
      },
    });
  }

  const { sessionId } = getClaimsFromAccessToken(accessToken);

  const headers = {
    'Set-Cookie': await destroySession(encryptedSession),
  };

  if (sessionId) {
    return redirect(workos.userManagement.getLogoutUrl({ sessionId }), {
      headers,
    });
  }

  return redirect('/', {
    headers,
  });
}

function getClaimsFromAccessToken(accessToken: string) {
  const { sid: sessionId, org_id: organizationId, role, permissions } = decodeJwt<AccessToken>(accessToken);

  return {
    sessionId,
    organizationId,
    role,
    permissions,
  };
}

async function getSessionFromCookie(cookie: string, context: AppLoadContext, session?: SessionData) {

  const { getSession } = getCookieFunctions(context);

  if (!session) {
    session = await getSession(cookie);
  }
  if (!context.cloudflare.env) {
    throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_MAX_AGE, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI must be set in the environment variables');
  }

  if (session.has('jwt')) {
    return unsealData<Session>(session.get('jwt'), {
      password: (context.cloudflare.env as Record<string, string>).WORKOS_COOKIE_PASSWORD,
    });
  } else {
    return null;
  }
}

export async function getSessionFromRequest(request: Request, context: AppLoadContext) {
  const cookie = request.headers.get('Cookie') || '';
  return getSessionFromCookie(cookie, context);
}

async function verifyAccessToken(accessToken: string, context: AppLoadContext) {
  try {
    await jwtVerify(accessToken, getJWKs(context));
    return true;
  } catch (e) {
    return false;
  }
}

function getReturnPathname(url: string): string {
  const newUrl = new URL(url);

  return `${newUrl.pathname}${newUrl.searchParams.size > 0 ? '?' + newUrl.searchParams.toString() : ''}`;
}

export { encryptSession, terminateSession, authkitLoader };

import { getSessionFromCookie } from "./authRoutes";
import {
  ensureUiLanguageColumn,
  getUserLanguagePreference,
  setUserLanguagePreference,
} from "../../utils/userAccessDatabase";

const SUPPORTED_LANGS = ["en", "ar"];

export const i18nRoutes = [
  {
    path: "/api/user/language-preference",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header("Cookie"));
        if (!session) {
          return c.json({ lang: null });
        }
        try {
          await ensureUiLanguageColumn();
          const lang =
            (await getUserLanguagePreference(session.userId)) || "en";
          return c.json({ lang: SUPPORTED_LANGS.includes(lang) ? lang : "en" });
        } catch {
          return c.json({ lang: "en" });
        }
      };
    },
  },
  {
    path: "/api/user/language-preference",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header("Cookie"));
        let body: any = {};
        try {
          body = await c.req.json();
        } catch (_) {}
        const lang = body?.lang;
        if (!lang || !SUPPORTED_LANGS.includes(lang)) {
          return c.json({ error: "Unsupported language" }, 400);
        }
        if (!session) {
          return c.json({ success: true, lang });
        }
        try {
          await ensureUiLanguageColumn();
          await setUserLanguagePreference(session.userId, lang);
        } catch (err) {
          return c.json(
            { error: "Failed to persist language preference" },
            500,
          );
        }
        return c.json({ success: true, lang });
      };
    },
  },
];

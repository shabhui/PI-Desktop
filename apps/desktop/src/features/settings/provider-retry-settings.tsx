import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  normalizeProviderRetryInitialDelayMs,
  normalizeProviderRetryMaxAttempts,
  PROVIDER_RETRY_MAX_RETRIES,
  type AppSettings,
} from "@pi-desktop/shared";
import { Input, SettingsToggle } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { SettingsRow } from "./primitives";

/**
 * The automatic provider retry policy as the user owns it (ADR 0338).
 *
 * Each numeric row shows the persisted value and leaves the field empty when
 * nothing is stored, because only then does the runtime apply its released
 * per-class defaults (ten retries; 2000 ms for rate limits, 1000 ms for other
 * transient failures). Clearing a stored value writes `null` to restore those
 * defaults; an already-empty field writes nothing. Only nonnegative safe
 * integers are saved as overrides.
 */
export function ProviderRetrySettingsRows({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <>
      <SettingsRow
        title={t("settings.infiniteProviderRetry")}
        description={t("settings.infiniteProviderRetryDesc")}
      >
        <SettingsToggle
          checked={settings.infiniteProviderRetry === true}
          label={t("settings.infiniteProviderRetry")}
          onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
        />
      </SettingsRow>
      <RetryLimitRow
        label={t("settings.providerRetryMaxAttempts")}
        description={t("settings.providerRetryMaxAttemptsDesc")}
        stored={normalizeProviderRetryMaxAttempts(settings.providerRetryMaxAttempts)}
        placeholder={String(PROVIDER_RETRY_MAX_RETRIES)}
        saveSettings={saveSettings}
        save={(value) => ({ providerRetryMaxAttempts: value })}
      />
      <RetryLimitRow
        label={t("settings.providerRetryInitialDelayMs")}
        description={t("settings.providerRetryInitialDelayMsDesc")}
        stored={normalizeProviderRetryInitialDelayMs(settings.providerRetryInitialDelayMs)}
        saveSettings={saveSettings}
        save={(value) => ({ providerRetryInitialDelayMs: value })}
      />
    </>
  );
}

/**
 * One persisted nonnegative-integer preference.
 *
 * The draft is committed on blur or Enter, never per keystroke, so a partially
 * typed number is never written. `placeholder` is shown for a preference whose
 * default is a single number; the initial wait has two per-class defaults and
 * documents them in its description instead of showing one misleading value.
 */
function RetryLimitRow({
  label,
  description,
  stored,
  placeholder,
  saveSettings,
  save,
}: {
  label: string;
  description: string;
  stored: number | undefined;
  placeholder?: string;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  save: (value: number | null) => Partial<AppSettings>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const draftValue = stored === undefined ? "" : String(stored);
  const [draft, setDraft] = useState(draftValue);

  // Follow persisted replacements from another surface (config sync, recovery).
  useEffect(() => {
    setDraft(draftValue);
  }, [draftValue]);

  const commit = async (badInput: boolean) => {
    const text = draft.trim();
    const parsed = text === "" ? null : Number(text);
    if (badInput || (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 0))) {
      setDraft(draftValue);
      showToast(t("settings.providerRetryInvalidValue"), { variant: "error" });
      return;
    }
    setDraft(parsed === null ? "" : String(parsed));
    if (parsed === null ? stored === undefined : parsed === stored) return;
    try {
      await saveSettings(save(parsed));
    } catch {
      setDraft(draftValue);
      showToast(t("settings.providerRetrySaveError"), { variant: "error" });
    }
  };

  return (
    <SettingsRow title={label} description={description}>
      <div className="settings-number-control">
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => void commit(event.currentTarget.validity.badInput)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

import { useState } from "react";
import { BugIcon, DownloadIcon, InfoIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";
import { checkForUpdates } from "@/lib/updater";
import { AboutDialog } from "@/components/layout/about-dialog";
import { ReportIssueDialog } from "@/components/layout/report-issue-dialog";

export function HelpTab() {
  const [reportOpen, setReportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const debugConsoleEnabled = useSettingsStore((s) => s.debugConsoleEnabled);
  const setDebugConsoleEnabled = useSettingsStore(
    (s) => s.setDebugConsoleEnabled,
  );

  return (
    <TabPane tightTop>
      <Group>
        <SettingRow
          icon={TerminalIcon}
          title="Debug console"
          description="Show a live log window of playback and streaming activity for bug reporting purposes."
          control={
            <Switch
              checked={debugConsoleEnabled}
              onCheckedChange={setDebugConsoleEnabled}
              aria-label="Debug console"
            />
          }
        />
        <SettingRow
          icon={DownloadIcon}
          title="Check for updates"
          description="See if a newer version of YTubic is available."
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkForUpdates({ silent: false })}
            >
              Check now
            </Button>
          }
        />
        <SettingRow
          icon={BugIcon}
          title="Report an issue"
          description="Tell us what went wrong or what you'd like to see, via GitHub."
          control={
            <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
              Report
            </Button>
          }
        />
        <SettingRow
          icon={InfoIcon}
          title="About"
          description="Version, credits, and links."
          control={
            <Button variant="outline" size="sm" onClick={() => setAboutOpen(true)}>
              View
            </Button>
          }
        />
      </Group>
      <ReportIssueDialog open={reportOpen} onOpenChange={setReportOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </TabPane>
  );
}

import {
  Bookmark,
  Calculator,
  ExternalLink,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Link2,
  ListTree,
  MapPin,
  Music,
  RefreshCcw,
  Rows3,
  SquareDashedBottom,
  Table as TableIcon,
  Video as VideoIcon,
  Workflow,
} from "lucide-react-native";
import {
  registerSlashMenuOptions,
  type SlashMenuOption,
} from "../slash-menu";

/**
 * Phase 3 (more block types) slash-menu entries. Registered as a side-effect
 * import — `apps/app/components/editor/editor.tsx` already imports the
 * slash-menu module on first render, so loading these entries before the menu
 * renders only requires importing this file from `block.tsx`.
 *
 * Coordinated with Editor v2 (#13): the framework owns the slash menu shell
 * and registry. We contribute entries here without forking that file.
 */
const PHASE_3_OPTIONS: readonly SlashMenuOption[] = [
  // Media
  {
    id: "media:image",
    type: "image",
    label: "Image",
    description: "Upload, embed, or paste an image URL.",
    keywords: ["picture", "photo", "img"],
    section: "media",
    Icon: ImageIcon,
  },
  {
    id: "media:video",
    type: "video",
    label: "Video",
    description: "Embed YouTube, Vimeo, Loom, or a video URL.",
    keywords: ["movie", "mp4"],
    section: "media",
    Icon: VideoIcon,
  },
  {
    id: "media:audio",
    type: "audio",
    label: "Audio",
    description: "Play an audio clip from a URL.",
    keywords: ["mp3", "sound"],
    section: "media",
    Icon: Music,
  },
  {
    id: "media:file",
    type: "file",
    label: "File",
    description: "Attach any file as a downloadable pill.",
    keywords: ["attachment", "upload"],
    section: "media",
    Icon: FileIcon,
  },
  {
    id: "media:pdf",
    type: "pdf",
    label: "PDF",
    description: "Embed a PDF document.",
    keywords: ["document"],
    section: "media",
    Icon: FileText,
  },

  // Embeds
  {
    id: "embeds:bookmark",
    type: "bookmark",
    label: "Bookmark",
    description: "Save a URL as a rich preview card.",
    keywords: ["link", "url", "preview"],
    section: "embeds",
    Icon: Bookmark,
  },
  {
    id: "embeds:embed",
    type: "embed",
    label: "Embed",
    description: "Embed a tweet, Figma, Codepen, Gist…",
    keywords: ["iframe", "media"],
    section: "embeds",
    Icon: ExternalLink,
  },
  {
    id: "embeds:youtube",
    type: "video",
    label: "YouTube",
    description: "Paste a YouTube URL.",
    keywords: ["youtube", "yt"],
    section: "embeds",
    Icon: VideoIcon,
  },

  // Advanced — layout, interactive, math
  {
    id: "advanced:columns",
    type: "columns",
    label: "Columns",
    description: "Split content into side-by-side columns.",
    keywords: ["layout", "grid"],
    section: "advanced",
    Icon: Rows3,
  },
  {
    id: "advanced:table",
    type: "table",
    label: "Table",
    description: "Simple editable table.",
    keywords: ["grid", "spreadsheet"],
    section: "advanced",
    Icon: TableIcon,
  },
  {
    id: "advanced:button",
    type: "button",
    label: "Button",
    description: "Add a clickable button with an action.",
    keywords: ["cta", "action"],
    section: "advanced",
    Icon: SquareDashedBottom,
  },
  {
    id: "advanced:link_to_page",
    type: "link_to_page",
    label: "Link to page",
    description: "Inline link to another page in this workspace.",
    keywords: ["mention", "wiki"],
    section: "advanced",
    Icon: Link2,
  },
  {
    id: "advanced:equation",
    type: "equation",
    label: "Equation",
    description: "Render LaTeX math.",
    keywords: ["math", "latex", "tex"],
    section: "advanced",
    Icon: Calculator,
  },
  {
    id: "advanced:mermaid",
    type: "mermaid",
    label: "Mermaid",
    description: "Render a diagram from Mermaid source.",
    keywords: ["diagram", "flowchart"],
    section: "advanced",
    Icon: Workflow,
  },
  {
    id: "advanced:table_of_contents",
    type: "table_of_contents",
    label: "Table of contents",
    description: "Auto-generated from page headings.",
    keywords: ["toc", "outline"],
    section: "advanced",
    Icon: ListTree,
  },
  {
    id: "advanced:breadcrumb",
    type: "breadcrumb",
    label: "Breadcrumb",
    description: "Path from workspace root to current page.",
    keywords: ["path", "nav"],
    section: "advanced",
    Icon: MapPin,
  },
  {
    id: "advanced:sync_block",
    type: "sync_block",
    label: "Synced block",
    description: "Reference another block (Phase 3 placeholder).",
    keywords: ["mirror", "reference"],
    section: "advanced",
    Icon: RefreshCcw,
  },
];

let registered = false;

/** Idempotent — safe to call repeatedly (slash menu dedupes by id). */
export function registerPhase3SlashMenu(): void {
  if (registered) return;
  registered = true;
  registerSlashMenuOptions(PHASE_3_OPTIONS);
}

// Side-effect: register on first module import.
registerPhase3SlashMenu();

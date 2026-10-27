/**
 * Alpha design system — public API. Import from `@aipotluck/alpha-ds`, never from a deep path.
 *
 *   Foundations  tokens (generated CSS), theme runtime
 *   Components   Base UI–shaped, skinnable parts           components/<name>/
 *   Primitives   layout: grouping elements together        primitives/<name>/
 *   Patterns     page structure (chat-app shape)     patterns/<name>/
 *
 * Browse everything at /designsystem. Architecture + how to extend: ./README.md.
 */

// Foundations
export {
	ThemeProvider,
	getThemeContext,
	COLOR_MODES,
	CUSTOM_THEME_ID,
	customThemeDeclarations,
	defaultCustomTheme,
	type ColorMode,
	type ResolvedMode,
	type CustomThemeInput
} from './theme/index.ts';
export { themes, accentPresets, type ThemeSeeds } from './tokens/themes.ts';
export { cn, tv, type VariantProps } from './internal/cn.ts';

// Components (Base UI)
export { Accordion } from './components/accordion/index.ts';
export { AlertDialog } from './components/alert-dialog/index.ts';
export { Avatar } from './components/avatar/index.ts';
export {
	Button,
	buttonRecipe,
	type ButtonVariants,
	type ButtonVariant,
	type ButtonSize
} from './components/button/index.ts';
export { Checkbox } from './components/checkbox/index.ts';
export { Collapsible } from './components/collapsible/index.ts';
export { Combobox, fuzzyFilter, fuzzyScore, type FuzzyItem } from './components/combobox/index.ts';
export { Dialog } from './components/dialog/index.ts';
export { Field } from './components/field/index.ts';
export { Input, inputRecipe } from './components/input/index.ts';
export { Menu } from './components/menu/index.ts';
export { Meter } from './components/meter/index.ts';
export { Popover } from './components/popover/index.ts';
export { PreviewCard } from './components/preview-card/index.ts';
export { Progress } from './components/progress/index.ts';
export { Radio, RadioGroup } from './components/radio/index.ts';
export { ScrollArea } from './components/scroll-area/index.ts';
export { Sheet, useCompact, COMPACT_QUERY } from './components/sheet/index.ts';
export { Select } from './components/select/index.ts';
export { Separator } from './components/separator/index.ts';
export { Slider } from './components/slider/index.ts';
export { Switch } from './components/switch/index.ts';
export { Tabs } from './components/tabs/index.ts';
export {
	Toast,
	createToastManager,
	toastManager,
	useToastManager,
	type ToastOptions
} from './components/toast/index.ts';
export { Toggle, toggleRecipe } from './components/toggle/index.ts';
export { ToggleGroup } from './components/toggle-group/index.ts';
export { Tooltip } from './components/tooltip/index.ts';

// Components (Alpha additions — no Base UI equivalent)
export { Badge } from './components/badge/index.ts';
export { Icon, iconRecipe } from './components/icon/index.ts';
export { Kbd } from './components/kbd/index.ts';
export { Spinner } from './components/spinner/index.ts';
export { Textarea } from './components/textarea/index.ts';

// Primitives
export { Center } from './primitives/center/index.ts';
export { Frame } from './primitives/frame/index.ts';
export { Grid } from './primitives/grid/index.ts';
export { Inline } from './primitives/inline/index.ts';
export { Stack } from './primitives/stack/index.ts';
export { Surface } from './primitives/surface/index.ts';
export { VisuallyHidden } from './primitives/visually-hidden/index.ts';

// Patterns
export { AppShell, getAppShell } from './patterns/app-shell/index.ts';
export {
	Attachment,
	attachmentCardRecipe,
	attachmentRowRecipe
} from './patterns/attachment/index.ts';
export { BentoTile, BENTO_COMPACT } from './patterns/bento/index.ts';
export { Composer, getComposer } from './patterns/composer/index.ts';
export {
	ComposerAccessory,
	pillRecipe,
	panelRecipe,
	noticeRecipe
} from './patterns/composer-accessory/index.ts';
export { DangerRow } from './patterns/danger-row/index.ts';
export { EmptyState, EmptyStateSuggestion } from './patterns/empty-state/index.ts';
export { Favicon } from './patterns/favicon/index.ts';
export { Message } from './patterns/message/index.ts';
export { PageHeader } from './patterns/page-header/index.ts';
export { Sidebar } from './patterns/sidebar/index.ts';
export { ThreadHeader } from './patterns/thread-header/index.ts';
export { Ticker } from './patterns/ticker/index.ts';

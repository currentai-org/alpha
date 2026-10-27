import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'menu',
	name: 'Menu',
	layer: 'component',
	description: 'A list of actions from a trigger — row menus, account menu, model picker.',
	keywords: ['dropdown', 'context', 'actions', 'more'],
	baseUi: { name: 'Menu', url: 'https://base-ui.com/react/components/menu' },
	deviations: [
		'Checkbox/Radio item indicators are folded into their items.',
		'Item `onClick` is `onSelect` (engine naming).'
	],
	anatomy: `<Menu.Root>
  <Menu.Trigger />
  <Menu.Portal>
    <Menu.Positioner>
      <Menu.Popup>
        <Menu.Group>
          <Menu.GroupLabel />
          <Menu.Item />
        </Menu.Group>
        <Menu.Separator />
        <Menu.CheckboxItem />
        <Menu.RadioGroup>
          <Menu.RadioItem />
        </Menu.RadioGroup>
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger />
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup />
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.SubmenuRoot>
      </Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>
</Menu.Root>`,
	parts: [
		{
			name: 'Menu.Root',
			description: '',
			engine: 'bits-ui DropdownMenu.Root',
			props: [{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' }]
		},
		{
			name: 'Menu.Trigger',
			description: 'Ghost Button by default.',
			engine: 'bits-ui DropdownMenu.Trigger'
		},
		{
			name: 'Menu.Positioner',
			description: 'Placement (default align start).',
			props: [
				{
					name: 'side',
					type: "'top' | 'right' | 'bottom' | 'left'",
					default: "'bottom'",
					description: ''
				},
				{ name: 'align', type: "'start' | 'center' | 'end'", default: "'center'", description: '' },
				{ name: 'sideOffset / alignOffset', type: 'number', default: '6 / 0', description: 'px' },
				{ name: 'collisionPadding', type: 'number', default: '8', description: '' }
			]
		},
		{
			name: 'Menu.Popup',
			description:
				'Surface 3 list, never taller than the room the positioner found. A longer list scrolls inside it, and each edge fades (scroll-fade-y) while there is more to scroll that way.',
			engine: 'bits-ui DropdownMenu.Content'
		},
		{
			name: 'Menu.Item',
			description: '',
			engine: 'bits-ui DropdownMenu.Item',
			props: [
				{ name: 'onSelect', type: '(e) => void', description: '' },
				{
					name: 'tone',
					type: "'default' | 'destructive'",
					default: "'default'",
					description: 'Destructive tints only the icon.'
				},
				{ name: 'disabled', type: 'boolean', description: '' }
			],
			dataAttributes: [
				{ name: 'data-highlighted', description: 'Keyboard/pointer focus.' },
				{ name: 'data-disabled', description: '' }
			]
		},
		{
			name: 'Menu.LinkItem',
			description: 'A navigating row.',
			props: [{ name: 'href', type: 'string', description: '' }]
		},
		{ name: 'Menu.Group / GroupLabel / Separator', description: 'Structure.' },
		{
			name: 'Menu.CheckboxItem',
			description: '',
			props: [{ name: 'checked', type: 'boolean', description: 'Bindable.' }]
		},
		{
			name: 'Menu.SubmenuRoot / SubmenuTrigger',
			description:
				'A nested menu. The trigger is an item row with a chevron; a Menu.Popup inside SubmenuRoot flies out beside it.',
			engine: 'bits-ui DropdownMenu.Sub / SubTrigger / SubContent',
			props: [
				{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable (SubmenuRoot).' }
			]
		},
		{
			name: 'Menu.RadioGroup / RadioItem',
			description: '',
			props: [{ name: 'value', type: 'string', description: 'Bindable on the group.' }]
		}
	],
	examples: [
		{ file: 'Hero', title: 'Conversation row menu' },
		{
			file: 'Submenu',
			title: 'Submenu',
			description: 'An Advanced flyout, as in the model picker.'
		}
	]
} satisfies DocEntry;

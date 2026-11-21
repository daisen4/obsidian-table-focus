# Table Focus

An Obsidian plugin that makes long and wide Markdown tables easier to read, without changing your notes.

Long tables scroll the header and the first columns out of view. Table Focus keeps them in place and lets you open a table on its own in full screen.

## Features

- **Frozen header rows and left columns** in Reading view. The default is 1 row and 2 columns, and you can change both numbers.
- **Full-screen table.** Open a single table in full screen. The same frozen rows and columns keep working there.
- **Row search.** A search box next to the full-screen button filters the rows of the table.
- **Highlight cells** that contain specific text. Up to three rules, each with a color (red, yellow, green or blue). Header cells are not affected.
- **Optional column width control.** Keep the automatic width, fit the table to the pane, or distribute widths by text length.
- **Edit mode support.** Open the table at the cursor in full screen with a command or the ribbon button.

Table Focus is display-only. It never modifies your notes. Disable the plugin and everything returns to normal.

## Requirements

- Obsidian 1.15.0 or later (tested on 1.15.0 and 1.15.1).
- Desktop only. Mobile is not supported.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/table-focus/`.
3. In Obsidian, open **Settings → Community plugins**, reload the list and enable **Table Focus**.

### With BRAT

Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose **Add beta plugin** and enter `daisen4/obsidian-table-focus`.

## Usage

- Open a note in Reading view. Tables that are larger than the pane get frozen header rows and left columns.
- Use the full-screen button on a table to see it on its own. Press `Esc` or the close button to return.
- In edit mode, put the cursor inside a table and run **View the table at the cursor in full screen** from the command palette, or use the ribbon button.

## Limitations

- The always-on freezing works in the Reading view pane only. Embeds, hover previews and canvas cards are not affected.
- Tables that already fit the pane are left alone.
- Desktop only.

## Contributing

Bug reports and pull requests are welcome, with no guarantee of a reply or a merge. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

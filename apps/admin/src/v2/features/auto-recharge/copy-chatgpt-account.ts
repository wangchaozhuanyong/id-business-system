export async function copyChatgptAccount(
  load: () => Promise<{ text: string }>,
  write: (text: string) => Promise<void>
) {
  const details = await load();
  try {
    await write(details.text);
  } finally {
    details.text = '';
  }
}

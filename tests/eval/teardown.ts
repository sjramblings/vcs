const API_URL = process.env.VCS_API_URL;
const API_KEY = process.env.VCS_API_KEY;

if (!API_URL || !API_KEY) {
  console.error('VCS_API_URL and VCS_API_KEY must be set');
  process.exit(1);
}

const response = await fetch(`${API_URL}/fs/rm?uri=${encodeURIComponent('viking://resources/eval/')}`, {
  method: 'DELETE',
  headers: { 'x-api-key': API_KEY },
});

console.log(`Teardown: ${response.status} ${response.statusText}`);
if (!response.ok) process.exit(1);

export function buildSeoPrompt({ keyword, category, urlTarget }) {
  return `
Genera una pagina SEO-oriented per Shopify basata sulla keyword principale: "${keyword}".

Contesto:
Il sito è Vistora.it, marketplace italiano di prodotti selezionati per casa, lifestyle, moda, beauty, gourmet, idee regalo e oggetti di pregio.

Categoria della pagina:
"${category || "Generale"}"

Requisiti:
- Lingua: italiano
- Lunghezza minima del campo html_body: 3.000 caratteri
- Tono: professionale, commerciale, utile per l’utente
- Stile: naturale, non artificiale, non ripetitivo
- Struttura HTML obbligatoria:
  - 1 H1
  - almeno 3 H2
  - paragrafi descrittivi
  - almeno un elenco puntato
  - sezione FAQ con almeno 4 domande e risposte
  - call to action finale
- Inserisci naturalmente la keyword principale
- Inserisci varianti semantiche e correlate della keyword
- Non generare contenuto generico, copiato o duplicato
- Non usare frasi vaghe prive di contenuto reale
- Non promettere prezzi, disponibilità, spedizioni, sconti o servizi non confermati
- Inserisci un link interno naturale verso: "${urlTarget || "https://vistora.it/"}"
- Il contenuto deve essere adatto a una pagina Shopify
- Non includere markdown
- Non includere commenti fuori dal JSON
- Il campo html_body deve contenere solo HTML valido

Output richiesto in JSON valido:
{
  "title": "",
  "handle": "",
  "meta_title": "",
  "meta_description": "",
  "html_body": ""
}

Regole SEO:
- title massimo 70 caratteri
- meta_title massimo 60 caratteri
- meta_description massimo 155 caratteri
- handle in minuscolo, senza accenti, senza caratteri speciali, con trattini
- html_body deve essere originale e specifico per la keyword "${keyword}"
`;
}

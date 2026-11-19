# Rezeptbuch

Lias persönliche Rezepte-App. Läuft im Browser auf iPad, Handy und PC und lässt sich zum Home-Bildschirm hinzufügen.

**Adresse:** https://lianeh-pixel.github.io/rezepte/

## Funktionen
- Rezepte anlegen, bearbeiten, löschen (Titel, Foto, Kategorie, Tags, Portionen, Zeiten, Zutaten, Schritte, Notizen, Quelle)
- Suche nach Titel, Zutat und Tag, Filter nach Kategorie/Tag und Favoriten
- Portionen umrechnen, Zutaten abhaken
- Kochmodus: große Schrift, Schritt für Schritt, Bildschirm bleibt an
- PDF-Export (ein Rezept oder alle)
- Nährwerte pro Portion aus der eingebauten Tabelle (`nutrition.js`); fehlende Zutaten kann man selbst eintragen
- Funktioniert offline zum Lesen (zuletzt geladener Stand)

## Technik
- Reines HTML/CSS/JavaScript, kein Build-Schritt. Gehostet mit GitHub Pages aus dem Branch `main`.
- Daten: Supabase-Projekt `rezeptbuch` (Tabellen `recipes`, `foods`, privater Speicher `photos`). Zugriff nur nach Login, jede Zeile gehört genau einem Konto (Row Level Security).
- `config.js` enthält nur den öffentlichen Schlüssel. Der ist absichtlich öffentlich; die Daten schützt der Login.
- Bibliotheken liegen in `vendor/` (supabase-js 2.118.0, jsPDF 4.2.1).
- Nach Änderungen an App-Dateien die `VERSION` in `sw.js` und das `?v=` in `index.html` erhöhen. Die App lädt neue Versionen dann beim nächsten Öffnen automatisch.

# Mesure d'audience anonyme (version 111)

- `mesure111.js` : le script ajouté à la page de l'appli (index.html). Il compare l'état de lecture enregistré sur l'appareil à la dernière fois et envoie des événements anonymes (ouverture, épisode, chapitre, défi, livre fini) au récepteur. Actif seulement sur enfinlu.fr ; refus possible dans les réglages (roue dentée de l'accueil).
- `worker.js` : le récepteur, à coller tel quel dans Cloudflare (Worker « enfinlu-mesure », adresse https://enfinlu-mesure.enfinlu.workers.dev). Base D1 liée sous le nom `DB` (juridiction UE), secret `CLE` pour le tableau de bord. La table se crée toute seule ; les données de plus de 25 mois sont effacées.
- Tableau de bord : https://enfinlu-mesure.enfinlu.workers.dev (clé demandée).

Détails : page de confidentialité (confidentialite.html#mesure).

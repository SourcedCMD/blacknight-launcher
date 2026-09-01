/* =========================================================================
   French.

   The first locale other than English, which is the point of it: a
   translation layer with one language in it has never actually been tested.
   Registering a real second catalogue is what proves the fallback works, that
   placeholders survive translation, and that nothing in the UI was quietly
   assuming English word order or length.

   Note the placeholders: `{count}`, `{size}` and the rest keep their names.
   They are filled by position in the string, not by order of appearance, so a
   sentence that reorders them still works.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  BN.i18n.register('fr', {
    'action.play': 'Jouer',
    'action.install': 'Installer',
    'action.get': 'Obtenir',
    'action.preload': 'Préchargement',
    'action.preorder': 'Précommander',
    'action.pause': 'Pause',
    'action.resume': 'Reprendre',
    'action.cancel': 'Annuler',
    'action.close': 'Fermer',
    'action.save': 'Enregistrer',
    'action.confirm': 'Confirmer',
    'action.wishlist': 'Liste de souhaits',
    'action.wishlisted': 'Dans la liste',
    'action.running': 'En cours',
    'action.locked': 'Bientôt disponible',
    'action.verify': 'Vérifier les fichiers',
    'action.uninstall': 'Désinstaller',
    'action.browse': 'Parcourir',
    'action.review': 'Bilan',
    'action.restore': 'Restaurer',

    'status.released': 'Disponible',
    'status.preorder': 'Précommande',
    'status.announced': 'Annoncé',
    'status.comingSoon': 'Bientôt',
    'status.installed': 'Installé',
    'status.running': 'En cours',
    'status.paused': 'En pause',
    'status.downloading': 'Téléchargement',
    'status.updating': 'Mise à jour',
    'status.preloaded': 'Préchargé — disponible le {date}',
    'status.download': 'Téléchargement de {size}',
    'status.daysToLaunch': '{days} jours avant la sortie',

    'nav.games': 'Jeux',
    'nav.store': 'Boutique',
    'nav.plus': 'BlackNight+',
    'nav.downloads': 'Téléchargements',
    'nav.settings': 'Paramètres',
    'nav.profile': 'Mon profil',

    'updates.available': '{count} mise à jour disponible',
    'updates.availablePlural': '{count} mises à jour disponibles',
    'updates.installAll': 'Tout mettre à jour',
    'updates.started': 'Mise à jour de {count} titre',
    'updates.startedPlural': 'Mise à jour de {count} titres',
    'updates.upToDate': 'Tout est à jour',

    'saves.backedUp': 'Sauvegarde copiée',
    'saves.none': 'Aucune sauvegarde pour le moment',
    'saves.restored': 'Sauvegarde restaurée',
    'saves.keepOnUninstall': 'Conserver mes sauvegardes',
    'saves.keepHint': 'Les sauvegardes sont copiées avant la suppression du dossier.',

    'storage.free': 'Libérer de l’espace',
    'storage.short': 'Libère {freed} — il manque encore {short}',
    'storage.enough': 'Libère {freed} — assez pour installer {title}',
    'storage.select': 'Sélectionnez les titres à supprimer',
    'storage.neverPlayed': 'jamais joué',
    'storage.idleDays': 'inactif depuis {days} jours',
    'storage.notRecent': 'pas joué récemment',

    'folders.title': 'Dossiers de la bibliothèque',
    'folders.add': 'Ajouter un dossier',
    'folders.primary': 'Principal',
    'folders.installedCount': '{count} installés',
    'folders.freeSpace': '{free} libres',
    'folders.chooseTitle': 'Où installer {title} ?',

    'error.generic': 'Une erreur est survenue',
    'error.loggedTo': 'Les détails ont été écrits dans le journal du lanceur.',
    'error.openLogs': 'Ouvrir les journaux',
    'error.crashed': '{title} s’est fermé de façon inattendue',
    'error.crashedBody': 'Sortie avec le code {code} après {seconds}s. Vérifier les fichiers peut aider.',
    'error.noSpace': 'Espace insuffisant'
  });
})();

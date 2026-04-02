  export const employer = {
      surname: "Pascal",
      name: "Lecault",
      phone_number: "450 596-0566",
      company: "Les Jardins Vegibec Inc.",
      address : "171, Rang Sainte-Sophie, Oka (Québec) J0N 1E0",
      email: "rh@vegibec.com",
      website: "www.vegibec.com",
    }

export const getJobDescription = (job: string) => {
  switch(job) {
    case "Manœuvre agricole":
        return "Préparer et entretenir les cultures \n (semer, planter, fertiliser, irriguer, tailler, sarcler, épierrer, désherber, etc.); \n récolter et préparer les cultures pour la vente (charger, décharger, transporter, etc.); \n effectuer l’entretien et les réparations mineures du matériel, des bâtiments et des équipements."
    case "Ouvrier agricole":
        return "Préparer et entretenir les cultures \n (semer, planter, fertiliser, irriguer, tailler, sarcler, épierrer, désherber, etc.); \n récolter et préparer les cultures pour la vente (charger, décharger, transporter, etc.); \n effectuer l’entretien et les réparations mineures du matériel, des bâtiments et des équipements; \n conduire le chariot de semis et de planter; conduire le chariot élévateur"
    case "Opérateur de machinerie agricole":
        return "Faire fonctionner l'équipement et les machines agricoles pour labourer le sol, planter, cultiver et récolter \n les cultures; conditionner, empaqueter, charger et décharger les cultures ou les conteneurs de matériaux; \n faire la maintenance, détecter les dysfonctionnement, assurer le respect des procédures de sécurité et effectuer \n des réparations mineures aux machines et équipements agricoles.  A l'occasion, il peut être amandé à effectuer \n des taches de manœuvre (planter, irriguer, récolter, préparer les cultures pour la vente, ect..) "
    case "Superviseur d’exploitation agricole":
        return "Coordonner, assigner et superviser le travail des employés agricoles;  superviser les opérations \n et l'entretien des lieux et des équipements;  élaborer des calendriers de travail et établir les méthodes; \n tenir des registres; exécuter, s'il y a lieu, des tâches de production  (préparer et entretenir les cultures, \n conduire de la machinerie, etc.)"
        default:
            break;
  }
} 
import type { Card, DigestItem } from "@finn/shared";
import type { ComponentType } from "react";
import { ManagementChangeCard } from "./management-change-card";
import { ResultsCard } from "./results-card";
import { CorporateActionCard, CreditRatingCard, DealCard, GenericCard, LitigationCard, OwnershipCard } from "./simple-cards";

type CardProps<K extends Card["kind"]> = { card: Extract<Card, { kind: K }>; item: DigestItem };

/** One presentational component per card kind; adding a kind to the schema forces an entry here. */
export const CARD_REGISTRY: { [K in Card["kind"]]: ComponentType<CardProps<K>> } = {
  results: ResultsCard,
  management_change: ManagementChangeCard,
  deal: DealCard,
  credit_rating: CreditRatingCard,
  corporate_action: CorporateActionCard,
  ownership: OwnershipCard,
  litigation: LitigationCard,
  generic: GenericCard,
};

export function CardBody({ card, item }: { card: Card; item: DigestItem }) {
  const Component = CARD_REGISTRY[card.kind] as ComponentType<{ card: Card; item: DigestItem }>;
  return <Component card={card} item={item} />;
}

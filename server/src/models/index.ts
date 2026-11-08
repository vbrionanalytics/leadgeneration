import mongoose, { Schema, Types, InferSchemaType, HydratedDocument } from 'mongoose';

const { ObjectId } = Schema.Types;
const ts = { timestamps: true } as const;

// ---------------------------------------------------------------- Organization
const OrganizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    plan: { type: String, enum: ['free', 'starter', 'growth', 'agency'], default: 'free' },
    planRenewsAt: Date,
    credits: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    // Sender identity — required for compliant outreach (CAN-SPAM, DPDP, PECR...)
    sender: {
      name: String,
      email: String,
      companyName: String,
      postalAddress: String,
      website: String,
      signature: String
    },
    // Services this organisation sells; used to recommend services to leads
    services: [{ name: String, description: String, priceHint: String }],
    defaultCountry: { type: String, default: 'IN' },
    compliance: {
      // Set true once the org has documented a legitimate-interest assessment (GDPR/UK GDPR)
      legitimateInterestAssessed: { type: Boolean, default: false },
      privacyNoticeUrl: String
    },
    // Optional BYO API keys (encrypted)
    secrets: { googlePlacesKey: String, anthropicKey: String }
  },
  ts
);

// ---------------------------------------------------------------- User
const UserSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
    isPlatformAdmin: { type: Boolean, default: false },
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 }
  },
  ts
);

// ---------------------------------------------------------------- API keys
const ApiKeySchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    createdBy: { type: ObjectId, ref: 'User' },
    name: { type: String, required: true },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true },
    scopes: { type: [String], default: ['leads:read', 'leads:write', 'search:write'] },
    lastUsedAt: Date,
    revokedAt: Date
  },
  ts
);

// ---------------------------------------------------------------- Search jobs
const SearchJobSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: ObjectId, ref: 'User' },
    query: {
      category: { type: String, required: true },
      city: String,
      country: { type: String, required: true },
      keywords: String,
      maxResults: { type: Number, default: 20 },
      provider: { type: String, enum: ['google_places', 'openstreetmap'], default: 'openstreetmap' }
    },
    autoAnalyze: { type: Boolean, default: false },
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true },
    stats: {
      found: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    },
    error: String,
    startedAt: Date,
    finishedAt: Date
  },
  ts
);

// ---------------------------------------------------------------- Leads
const ContactSchema = new Schema(
  {
    type: { type: String, enum: ['email', 'phone', 'whatsapp', 'linkedin', 'form'], required: true },
    value: { type: String, required: true },
    kind: { type: String, enum: ['generic_business', 'personal_named', 'unknown'], default: 'unknown' },
    // Where the contact was found. Never AI-generated.
    source: { type: String, enum: ['google_places', 'openstreetmap', 'website_public', 'manual', 'consent_form', 'marketplace'], required: true },
    sourceUrl: String,
    consentBasis: { type: String, enum: ['none', 'published_business_address', 'legitimate_interest', 'express_consent'], default: 'none' },
    foundAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const LeadSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    searchJobId: { type: ObjectId, ref: 'SearchJob' },
    source: { type: String, enum: ['google_places', 'openstreetmap', 'manual', 'import', 'marketplace'], required: true },
    sourceId: String, // e.g. Google place_id (may be stored indefinitely per Places policy)
    name: { type: String, required: true },
    category: String,
    address: String,
    city: String,
    country: String,
    phone: String,
    website: String,
    rating: Number,
    reviewCount: Number,
    location: { lat: Number, lng: Number },
    googleMapsUrl: String,
    listingUrl: String, // OpenStreetMap or other public listing page
    businessStatus: String,
    placesFetchedAt: Date, // used to purge/refresh Places content after PLACES_CACHE_DAYS
    dedupeKeys: { type: [String], index: true },
    contacts: [ContactSchema],
    status: { type: String, enum: ['new', 'qualified', 'contacted', 'replied', 'won', 'lost', 'do_not_contact'], default: 'new', index: true },
    analysisStatus: { type: String, enum: ['none', 'queued', 'running', 'done', 'failed'], default: 'none' },
    score: { type: Number, min: 0, max: 100 },
    scoreBreakdown: { type: Map, of: Number },
    scoreSummary: String,
    scoredBy: { type: String, enum: ['claude', 'heuristic'] },
    evidence: [{ signal: String, detail: String, source: String, impact: Number }],
    opportunities: [{ title: String, description: String, priority: { type: String, enum: ['high', 'medium', 'low'] } }],
    recommendedServices: [{ name: String, reason: String }],
    website_analysis: Schema.Types.Mixed,
    analyzedAt: Date,
    tags: [String],
    notes: String,
    assignedTo: { type: ObjectId, ref: 'User' },
    purchasedFromListingId: { type: ObjectId, ref: 'MarketplaceListing' }
  },
  ts
);
LeadSchema.index({ orgId: 1, score: -1 });
LeadSchema.index({ orgId: 1, createdAt: -1 });
LeadSchema.index({ orgId: 1, dedupeKeys: 1 });

// ---------------------------------------------------------------- Campaigns & emails
const CampaignSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true },
    goal: String,
    tone: { type: String, default: 'professional' },
    status: { type: String, enum: ['draft', 'active', 'paused', 'completed'], default: 'draft' },
    createdBy: { type: ObjectId, ref: 'User' }
  },
  ts
);

const EmailSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
    campaignId: { type: ObjectId, ref: 'Campaign', index: true },
    to: { type: String, required: true, lowercase: true },
    contactId: ObjectId,
    subject: { type: String, required: true },
    body: { type: String, required: true }, // plain text written by AI / edited by user (no footer)
    status: {
      type: String,
      enum: ['generating', 'pending_approval', 'approved', 'rejected', 'queued', 'sent', 'failed', 'blocked'],
      default: 'pending_approval',
      index: true
    },
    compliance: { country: String, law: String, basis: String, allowed: Boolean, reasons: [String] },
    approvedBy: { type: ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectedReason: String,
    sentAt: Date,
    providerMessageId: String,
    trackingId: { type: String, unique: true, sparse: true },
    unsubscribeToken: { type: String, index: true },
    opens: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    firstOpenedAt: Date,
    repliedAt: Date,
    error: String,
    generatedBy: { type: String, enum: ['ai', 'template', 'manual'], default: 'ai' }
  },
  ts
);

// ---------------------------------------------------------------- Suppression list
const SuppressionSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', index: true }, // null => global suppression across all tenants
    value: { type: String, required: true, lowercase: true }, // email or @domain
    type: { type: String, enum: ['email', 'domain'], required: true },
    reason: { type: String, enum: ['unsubscribed', 'bounced', 'complaint', 'manual', 'legal_request'], required: true },
    source: String
  },
  ts
);
SuppressionSchema.index({ orgId: 1, value: 1 }, { unique: true });

// ---------------------------------------------------------------- Credits ledger
const CreditTxnSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    amount: { type: Number, required: true }, // + grant, - spend
    balanceAfter: Number,
    type: { type: String, enum: ['grant', 'purchase', 'spend', 'refund', 'adjustment', 'marketplace_sale', 'marketplace_purchase'], required: true },
    reason: String,
    refId: String,
    idempotencyKey: { type: String, unique: true, sparse: true }
  },
  ts
);

// ---------------------------------------------------------------- Marketplace
const ListingSchema = new Schema(
  {
    sellerOrgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    leadId: { type: ObjectId, ref: 'Lead', required: true },
    // Public preview — no contact details, no Google-Places content beyond category/city/country
    preview: {
      title: String,
      category: String,
      city: String,
      country: String,
      score: Number,
      opportunities: [String],
      hasEmail: Boolean,
      hasPhone: Boolean,
      hasWebsite: Boolean
    },
    priceCredits: { type: Number, required: true, min: 1 },
    exclusive: { type: Boolean, default: false },
    maxSales: { type: Number, default: 5 },
    salesCount: { type: Number, default: 0 },
    status: { type: String, enum: ['pending_review', 'active', 'rejected', 'sold_out', 'withdrawn', 'expired'], default: 'pending_review', index: true },
    review: { passed: Boolean, issues: [String], reviewedAt: Date, by: String },
    expiresAt: Date
  },
  ts
);

const PurchaseSchema = new Schema(
  {
    listingId: { type: ObjectId, ref: 'MarketplaceListing', required: true },
    buyerOrgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    sellerOrgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    priceCredits: Number,
    feeCredits: Number,
    deliveredLeadId: { type: ObjectId, ref: 'Lead' },
    status: { type: String, enum: ['completed', 'refunded', 'disputed'], default: 'completed' }
  },
  ts
);
PurchaseSchema.index({ listingId: 1, buyerOrgId: 1 }, { unique: true });

// ---------------------------------------------------------------- Background jobs (Mongo-backed queue)
const JobSchema = new Schema(
  {
    type: { type: String, required: true, index: true },
    payload: Schema.Types.Mixed,
    orgId: { type: ObjectId, ref: 'Organization' },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lastError: String
  },
  ts
);

// ---------------------------------------------------------------- Audit log
const AuditSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', index: true },
    userId: { type: ObjectId, ref: 'User' },
    action: { type: String, required: true },
    target: String,
    meta: Schema.Types.Mixed,
    ip: String
  },
  ts
);

// ---------------------------------------------------------------- Payments
const PaymentSchema = new Schema(
  {
    orgId: { type: ObjectId, ref: 'Organization', required: true, index: true },
    provider: { type: String, default: 'razorpay' },
    providerOrderId: { type: String, unique: true },
    providerPaymentId: String,
    kind: { type: String, enum: ['plan', 'credit_pack'] },
    itemId: String,
    amountInr: Number,
    status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' }
  },
  ts
);

export const Organization = mongoose.model('Organization', OrganizationSchema);
export const User = mongoose.model('User', UserSchema);
export const ApiKey = mongoose.model('ApiKey', ApiKeySchema);
export const SearchJob = mongoose.model('SearchJob', SearchJobSchema);
export const Lead = mongoose.model('Lead', LeadSchema);
export const Campaign = mongoose.model('Campaign', CampaignSchema);
export const Email = mongoose.model('Email', EmailSchema);
export const Suppression = mongoose.model('Suppression', SuppressionSchema);
export const CreditTxn = mongoose.model('CreditTxn', CreditTxnSchema);
export const MarketplaceListing = mongoose.model('MarketplaceListing', ListingSchema);
export const MarketplacePurchase = mongoose.model('MarketplacePurchase', PurchaseSchema);
export const Job = mongoose.model('Job', JobSchema);
export const AuditLog = mongoose.model('AuditLog', AuditSchema);
export const Payment = mongoose.model('Payment', PaymentSchema);

export type LeadDoc = HydratedDocument<InferSchemaType<typeof LeadSchema>>;
export type OrgDoc = HydratedDocument<InferSchemaType<typeof OrganizationSchema>>;
export type EmailDoc = HydratedDocument<InferSchemaType<typeof EmailSchema>>;
export { Types };

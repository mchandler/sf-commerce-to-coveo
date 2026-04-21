'use strict';

// Salesforce field API names for the 25 extended-attribute Coveo fields.
//
// PLACEHOLDER NAMES — based on the Coveo field names in the spec.
// Verify each against the actual Product2 / ProductAttribute schema on the
// target org before the first run. A mismatched name causes the SOQL query
// to fail with INVALID_FIELD, surfacing the bad mapping immediately.

const PRODUCT2_FIELDS = {
  ec_balancer_number:       'Balancer_Number__c',
  ec_closer_type:           'Closer_Type__c',
  ec_fastener_type:         'Fastener_Type__c',
  ec_insect_screen_height:  'Insect_Screen_Height__c',
  ec_insect_screen_width:   'Insect_Screen_Width__c',
  ec_install_method:        'Install_Method__c',
  ec_product_style:         'Product_Style__c',
  ec_series:                'Series__c',
  ec_vintage:               'Vintage__c',
  ec_works_with:            'Works_With__c',
};

// ProductAttribute is not currently the source for these 15 fields. The
// Andersen data integration writes attribute values to Product2 first and
// then propagates them to ProductAttribute, so Product2 is the more
// trustworthy source today. We keep this constant defined so we can
// swap back to ProductAttribute sourcing (see commented code in
// lib/lookups.js, lib/document.js, export-products.js) if the data team
// later advises.
const PRODUCTATTRIBUTE_FIELDS = {
  ec_color_or_finish:       'Color_Or_Finish__c',
  ec_door_style:            'Door_Style__c',
  ec_exterior_color:        'Exterior_Color__c',
  ec_glass_type:            'Glass_Type__c',
  ec_grille_style:          'Grille_Style__c',
  ec_grille_type:           'Grille_Type__c',
  ec_handing:               'Handing__c',
  ec_interior_color:        'Interior_Color__c',
  ec_notched:               'Notched__c',
  ec_operator_style:        'Operator_Style__c',
  ec_sash_ratio:            'Sash_Ratio__c',
  ec_tempered:              'Tempered__c',
  ec_visible_glass_height:  'Visible_Glass_Height__c',
  ec_visible_glass_width:   'Visible_Glass_Width__c',
  ec_weather_stripping:     'Weather_Stripping__c',
};

// Active source for the 15 attribute fields today. Same Coveo keys as
// PRODUCTATTRIBUTE_FIELDS; API names all match EXCEPT `Color_or_Finish__c`
// which is cased differently on Product2 (lowercase 'o' in 'or') than on
// ProductAttribute (`Color_Or_Finish__c`).
const ATTRIBUTE_FIELDS_FROM_PRODUCT2 = {
  ec_color_or_finish:       'Color_or_Finish__c',
  ec_door_style:            'Door_Style__c',
  ec_exterior_color:        'Exterior_Color__c',
  ec_glass_type:            'Glass_Type__c',
  ec_grille_style:          'Grille_Style__c',
  ec_grille_type:           'Grille_Type__c',
  ec_handing:               'Handing__c',
  ec_interior_color:        'Interior_Color__c',
  ec_notched:               'Notched__c',
  ec_operator_style:        'Operator_Style__c',
  ec_sash_ratio:            'Sash_Ratio__c',
  ec_tempered:              'Tempered__c',
  ec_visible_glass_height:  'Visible_Glass_Height__c',
  ec_visible_glass_width:   'Visible_Glass_Width__c',
  ec_weather_stripping:     'Weather_Stripping__c',
};

const PART_SHORT_DESC_FIELD = 'Part_Short_Description__c';

module.exports = {
  PRODUCT2_FIELDS,
  PRODUCTATTRIBUTE_FIELDS,
  ATTRIBUTE_FIELDS_FROM_PRODUCT2,
  PART_SHORT_DESC_FIELD,
};
